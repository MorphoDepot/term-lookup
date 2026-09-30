// Lookup pipeline, run entirely in the browser (every service below allows cross-site requests).
//   1. GBIF recognizes the specimen's name (species or any higher group) and gives its lineage.
//   2. NCBI Taxonomy supplies the clade path (Vertebrata, Tetrapoda, Testudines...) that ontologies
//      use: walk up the GBIF lineage to the lowest name NCBI knows.
//   3. Anatomy ontologies are chosen when their taxon (OBO Foundry registry, or our override file) is
//      in that clade path.
//   4. OLS searches each segment name in those ontologies; only the ontology that defines a term counts.
//   5. Ubergraph checks Uberon matches against the specimen (e.g. carapace -> Testudines only).
window.TermLookup = (() => {
  "use strict";
  const OBO_REGISTRY = "https://obofoundry.org/registry/ontologies.jsonld";
  const OLS_SEARCH = "https://www.ebi.ac.uk/ols4/api/search";
  const UBERGRAPH = "https://ubergraph.apps.renci.org/sparql";
  const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
  const GBIF_MATCH = "https://api.gbif.org/v1/species/match";

  // Registry "anatomy and development" entries that are not gross-anatomy vocabularies.
  const NOT_GROSS_ANATOMY = new Set(["bto", "clo", "cl", "hom", "bspo", "fbdv", "zfs", "wbls", "mmusdv",
    "hsapdv", "olatdv", "ddpheno", "pdumdv"]);
  const KINGDOM_TO_NCBI = { Animalia: "Metazoa", Plantae: "Viridiplantae" };
  const GBIF_RANKS = ["species", "genus", "family", "order", "class", "phylum", "kingdom"];
  const STATUS_RANK = { ok: 0, ontology: 0, unrestricted: 1, unchecked: 1, unverified: 2, outside: 3 };
  const MATCH_RANK = { label: 0, qualified: 0, synonym: 1, partial: 2 };
  // AISM labels many general terms with an "insect" prefix ("insect mandible", "insect head") and gives
  // no unprefixed synonym. Typing "mandible" matches "insect mandible" as a label ("qualified" match).
  const QUALIFIER = { aism: "insect" };
  const AUTO_OK = new Set(["ok", "ontology", "unrestricted", "unchecked"]);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------ HTTP helpers

  async function fetchRetry(url, opts = {}) {
    const host = new URL(url, location.href).host;
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await fetch(url, opts);
      } catch (e) {
        if (attempt >= 3) throw new Error(`Could not reach ${host}.`);
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (r.ok) return r;
      // Retry rate limits (429) and server errors with backoff.
      if (attempt >= 3 || !(r.status === 429 || r.status >= 500)) throw new Error(`${host} returned HTTP ${r.status}.`);
      await sleep(1500 * (attempt + 1));
    }
  }
  const getJson = async (url, opts) => (await fetchRetry(url, opts)).json();
  const getXml = async (url) => new DOMParser().parseFromString(await (await fetchRetry(url)).text(), "application/xml");

  // Cache a promise per key; drop it on failure so a retry can succeed.
  function memo(fn) {
    const cache = new Map();
    return (key) => {
      if (!cache.has(key)) {
        const p = fn(key);
        cache.set(key, p);
        p.catch(() => cache.delete(key));
      }
      return cache.get(key);
    };
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  // NCBI E-utilities allow 3 requests/second without an API key: run them one at a time, spaced out.
  let ncbiQueue = Promise.resolve();
  let ncbiLast = 0;
  function ncbi(path, params) {
    const url = `${EUTILS}/${path}?${new URLSearchParams({ ...params, tool: "morphodepot-term-lookup" })}`;
    const run = async () => {
      const wait = 360 - (Date.now() - ncbiLast);
      if (wait > 0) await sleep(wait);
      ncbiLast = Date.now();
      return getXml(url);
    };
    const p = ncbiQueue.then(run, run);
    ncbiQueue = p.catch(() => {});
    return p;
  }

  const txt = (el, tag) => el.querySelector(`:scope > ${tag}`)?.textContent ?? null;

  const ncbiSearch = memo(async (name) => {
    const doc = await ncbi("esearch.fcgi", { db: "taxonomy", retmax: 5, term: `"${name}"[Scientific Name]` });
    return [...doc.querySelectorAll("IdList > Id")].map((e) => e.textContent);
  });

  const ncbiFetch = memo(async (ids) => {
    const doc = await ncbi("efetch.fcgi", { db: "taxonomy", id: ids });
    return [...doc.querySelectorAll("TaxaSet > Taxon")].map((t) => {
      const me = { id: txt(t, "TaxId"), name: txt(t, "ScientificName"), rank: txt(t, "Rank") };
      const lineage = [...t.querySelectorAll(":scope > LineageEx > Taxon")].map((x) =>
        ({ id: txt(x, "TaxId"), name: txt(x, "ScientificName"), rank: txt(x, "Rank") }));
      return { ...me, lineage: [...lineage, me] };
    });
  });

  const ncbiLineageIds = memo(async (taxid) => {
    const recs = await ncbiFetch(taxid);
    return recs.length ? recs[0].lineage.map((x) => x.id) : null;
  });

  // ------------------------------------------------------------ ontology registry

  let registryPromise = null;
  function registry() {
    if (!registryPromise) {
      registryPromise = (async () => {
        const [reg, ov] = await Promise.all([getJson(OBO_REGISTRY), getJson("ontology_taxa_overrides.json")]);
        const overrides = ov.ontologies || {};
        const out = {};
        for (const o of reg.ontologies) {
          if (o.domain !== "anatomy and development" || o.activity_status !== "active" || o.is_obsolete
              || NOT_GROSS_ANATOMY.has(o.id)) continue;
          const t = o.taxon || {};
          const e = { id: o.id, title: o.title || "", prefix: o.preferredPrefix || o.id.toUpperCase(),
            taxon: t.id || null, taxonLabel: t.label || null, taxonSource: t.id ? "registry" : null, note: null };
          const v = overrides[o.id];
          if (v) Object.assign(e, { taxon: v.taxon, taxonLabel: v.label, taxonSource: "override", note: v.note || null });
          out[o.id] = e;
        }
        return out;
      })();
      registryPromise.catch(() => { registryPromise = null; });
    }
    return registryPromise;
  }

  // ------------------------------------------------------------ step 1: specimen

  async function resolveName(input) {
    const name = (input || "").trim();
    if (!name) return { ok: false, error: "Enter a species or a higher group." };
    const g = await getJson(`${GBIF_MATCH}?${new URLSearchParams({ name })}`);
    if ((g.matchType || "NONE") === "NONE" || !g.kingdom) {
      return { ok: false, error: `GBIF does not recognize “${name}”. Check the spelling, or enter a higher group (genus, family, order…).` };
    }
    const gbif = { matchType: g.matchType, status: g.status, rank: g.rank, scientificName: g.scientificName,
      canonicalName: g.canonicalName, species: g.species, confidence: g.confidence, usageKey: g.usageKey,
      acceptedUsageKey: g.acceptedUsageKey,
      lineage: [...GBIF_RANKS].reverse().filter((r) => g[r]).map((r) => ({ rank: r, name: g[r] })) };

    // Names that should appear in the right NCBI record's lineage (disambiguates homonyms such as
    // Morus the mulberry vs Morus the gannet).
    const context = new Set(["phylum", "class", "order", "family"].map((r) => g[r]).filter(Boolean));
    context.add(KINGDOM_TO_NCBI[g.kingdom] || g.kingdom);
    const overlap = (rec) => rec.lineage.filter((x) => context.has(x.name)).length;

    const matchedRank = (g.rank || "").toLowerCase();
    const chain = [];
    for (const [rank, raw] of [[matchedRank, g.canonicalName], ...GBIF_RANKS.map((r) => [r, g[r]])]) {
      if (!raw) continue;
      const nm = rank === "kingdom" ? (KINGDOM_TO_NCBI[raw] || raw) : raw;
      if (!chain.some((c) => c[1] === nm)) chain.push([rank, nm]);
    }

    let anchor = null;
    for (let i = 0; i < chain.length && !anchor; i++) {
      const [rank, nm] = chain[i];
      const ids = await ncbiSearch(nm);
      if (!ids.length) continue;
      const recs = await ncbiFetch(ids.join(","));
      if (!recs.length) continue;
      const best = recs.reduce((a, b) => (overlap(b) > overlap(a) ? b : a));
      if (!overlap(best) && rank !== "kingdom" && rank !== "phylum") continue;
      const exact = i === 0 || (rank === "species" && ["species", "subspecies", "variety", "form"].includes(matchedRank));
      anchor = { taxid: best.id, name: best.name, rank: best.rank, via: rank, exact, lineage: best.lineage };
    }

    const lineage = anchor ? anchor.lineage : [];
    const pos = new Map(lineage.map((x, i) => [x.id, i]));
    const onts = Object.values(await registry()).map((o) => {
      const e = { ...o };
      const tid = o.taxon ? o.taxon.split(":").pop() : null;
      if (tid && pos.has(tid)) {
        const modelOrganism = ["genus", "species", "subspecies"].includes(lineage[pos.get(tid)].rank);
        // Single-genus model-organism ontologies (MA, EMAPA, ZFA, XAO, FBbt...) rank below Uberon,
        // the cross-species standard MorphoDepot tables already use.
        Object.assign(e, { status: "matched", depth: pos.get(tid), modelOrganism, pref: modelOrganism ? 0 : pos.get(tid) + 1 });
      } else {
        Object.assign(e, { status: tid ? "other-taxon" : "no-taxon", pref: -1 });
      }
      return e;
    });
    onts.sort((a, b) => (a.status !== "matched") - (b.status !== "matched") || b.pref - a.pref || a.id.localeCompare(b.id));
    return { ok: true, input: name, gbif, ncbi: anchor, ontologies: onts };
  }

  // ------------------------------------------------------------ step 2: terms

  async function olsSearch(term, ids, exact, rows) {
    const p = new URLSearchParams({ q: term, ontology: ids.join(","), queryFields: "label,synonym", rows, type: "class",
      fieldList: "iri,label,obo_id,ontology_name,ontology_prefix,is_defining_ontology,description,synonym" });
    if (exact) p.set("exact", "true");
    const d = await getJson(`${OLS_SEARCH}?${p}`);
    return d.response.docs.filter((x) => x.is_defining_ontology);
  }

  async function searchTerm(term, inside, outside) {
    const cands = new Map();
    const add = (docs, kind, isOutside) => {
      for (const d of docs) {
        if (cands.has(d.iri)) continue;
        const label = d.label || "";
        const match = kind === "exact" ? (label.toLowerCase() === term.toLowerCase() ? "label" : "synonym") : kind;
        cands.set(d.iri, { iri: d.iri, oboId: d.obo_id, label, ontology: d.ontology_name, prefix: d.ontology_prefix,
          definition: (d.description || [""])[0], synonyms: (d.synonym || []).slice(0, 6), match, outside: isOutside });
      }
    };
    if (inside.length) {
      const quals = inside.filter((i) => QUALIFIER[i] && !term.toLowerCase().startsWith(`${QUALIFIER[i]} `));
      const [exact, partial, ...qualified] = await Promise.all([olsSearch(term, inside, true, 50),
        olsSearch(term, inside, false, 25), ...quals.map((i) => olsSearch(`${QUALIFIER[i]} ${term}`, [i], true, 5))]);
      add(exact, "exact", false);
      quals.forEach((i, k) => add(qualified[k].filter((d) =>
        (d.label || "").toLowerCase() === `${QUALIFIER[i]} ${term}`.toLowerCase()), "qualified", false));
      add(partial.slice(0, 10), "partial", false);
    }
    if (outside.length) add(await olsSearch(term, outside, true, 50), "exact", true);
    return [...cands.values()];
  }

  const constraintCache = new Map();

  async function sparql(query) {
    // A form-encoded POST with an Accept header is a "simple" cross-site request (no preflight).
    const d = await getJson(UBERGRAPH, { method: "POST", body: new URLSearchParams({ query }),
      headers: { Accept: "application/sparql-results+json" } });
    return d.results.bindings;
  }

  // {UBERON:x: {onlyIn: [taxid, label] | null, neverIn: [[taxid, label]]}} from Ubergraph's inferred
  // in_taxon (RO:0002162; the most specific one is kept) and asserted never_in_taxon (RO:0002161).
  async function ubergraphConstraints(oboIds) {
    const todo = oboIds.filter((i) => !constraintCache.has(i));
    if (todo.length) {
      const values = todo.map((i) => "obo:" + i.replace(":", "_")).join(" ");
      const pre = "PREFIX obo: <http://purl.obolibrary.org/obo/>\nPREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n";
      const taxFilter = (v) => `FILTER(STRSTARTS(STR(?${v}), "http://purl.obolibrary.org/obo/NCBITaxon_") && !CONTAINS(STR(?${v}), "Union"))`;
      const qIn = `${pre}SELECT ?term ?t ?tl (COUNT(DISTINCT ?u) AS ?depth) WHERE {
          VALUES ?term { ${values} }
          ?term obo:RO_0002162 ?t . ${taxFilter("t")}
          ?term obo:RO_0002162 ?u . ${taxFilter("u")}
          ?t rdfs:subClassOf ?u . OPTIONAL { ?t rdfs:label ?tl }
        } GROUP BY ?term ?t ?tl`;
      const qNever = `${pre}SELECT ?term ?t ?tl WHERE {
          VALUES ?term { ${values} }
          ?term obo:RO_0002161 ?t . OPTIONAL { ?t rdfs:label ?tl } }`;
      const found = new Map(todo.map((i) => [i, { onlyIn: null, neverIn: [], depth: -1 }]));
      const tid = (b) => b.t.value.split("_").pop();
      const oid = (b) => b.term.value.split("/").pop().replace("_", ":");
      const [inRows, neverRows] = await Promise.all([sparql(qIn), sparql(qNever)]);
      for (const b of inRows) {
        const rec = found.get(oid(b)), depth = +b.depth.value;
        if (rec && depth > rec.depth) Object.assign(rec, { onlyIn: [tid(b), b.tl?.value || ""], depth });
      }
      for (const b of neverRows) {
        const rec = found.get(oid(b));
        if (rec) rec.neverIn.push([tid(b), b.tl?.value || ""]);
      }
      for (const [i, rec] of found) constraintCache.set(i, { onlyIn: rec.onlyIn, neverIn: rec.neverIn });
    }
    return Object.fromEntries(oboIds.map((i) => [i, constraintCache.get(i)]));
  }

  async function classify(c, anchor, lineageIds, constraints) {
    if (!constraints) return ["unchecked", "Taxon check unavailable (Ubergraph unreachable)."];
    const con = constraints[c.oboId] || { onlyIn: null, neverIn: [] };
    for (const [t, tl] of con.neverIn) {
      if (lineageIds.has(t)) return ["incompatible", `Uberon says this structure never occurs in ${tl}.`];
    }
    if (!con.onlyIn || con.onlyIn[0] === "1" || con.onlyIn[0] === "131567") {
      return ["unrestricted", "Uberon records no taxon restriction for this term."];
    }
    const [t, tl] = con.onlyIn;
    if (lineageIds.has(t)) return ["ok", `Uberon restricts this term to ${tl}; the specimen is in ${tl}.`];
    let tlin = null;
    try { tlin = await ncbiLineageIds(t); } catch (e) { tlin = null; }
    if (!tlin) return ["unverified", `Uberon restricts this term to ${tl}, which could not be placed in NCBI.`];
    if (!anchor.exact && tlin.includes(anchor.taxid)) {
      return ["unverified", `Uberon restricts this term to ${tl}; the specimen is only placed as far as ${anchor.name}, so membership can't be confirmed.`];
    }
    return ["incompatible", `Uberon restricts this term to ${tl}; the specimen is not in ${tl}.`];
  }

  // Ontology preference among matches: clade ontologies (HAO, AISM, PO, SPD...) first, then Uberon,
  // then single-genus model-organism ontologies (MA, EMAPA, ZFA, XAO, FBbt...). Uberon cross-references
  // the model-organism terms, so preferring it loses nothing and keeps tables comparable across species.
  function ontologyTier(id, o) {
    if (id === "uberon") return 1;
    return o.modelOrganism ? 2 : 0;
  }

  // Exact before partial; taxon-valid before unverified/outside; then ontology tier; then label before
  // synonym; then confirmed-taxon before no-restriction; then the more specific ontology.
  const VALIDITY = { ok: 0, ontology: 0, unrestricted: 0, unchecked: 0, unverified: 1, outside: 2 };
  function compareCandidates(a, b) {
    return (a.match === "partial") - (b.match === "partial")
      || VALIDITY[a.status] - VALIDITY[b.status]
      || a.tier - b.tier
      || MATCH_RANK[a.match] - MATCH_RANK[b.match]
      || STATUS_RANK[a.status] - STATUS_RANK[b.status]
      || b.pref - a.pref
      || a.label.localeCompare(b.label);
  }

  async function lookupTerms(terms, species, includeOutside, onProgress = () => {}) {
    const anchor = species.ncbi;
    const onts = Object.fromEntries((species.ontologies || []).map((o) => [o.id, o]));
    const reg = await registry();
    const inside = Object.keys(onts).filter((i) => onts[i].status === "matched");
    const outside = includeOutside ? Object.keys(reg).filter((i) => !inside.includes(i)) : [];
    const lineageIds = new Set((anchor ? anchor.lineage : []).map((x) => x.id));

    let done = 0;
    const found = await mapLimit(terms, 4, async (t) => {
      const r = await searchTerm(t, inside, outside);
      onProgress(`Searched ${++done} of ${terms.length} names…`);
      return r;
    });

    const warnings = [];
    const uberon = [...new Set(found.flat().filter((c) => c.ontology === "uberon" && !c.outside && c.oboId).map((c) => c.oboId))].sort();
    let constraints = {};
    if (uberon.length) {
      onProgress("Checking Uberon matches against the specimen's taxon…");
      try {
        constraints = await ubergraphConstraints(uberon);
      } catch (e) {
        constraints = null;
        warnings.push(`Ubergraph taxon check failed (${e.message}); Uberon matches are unchecked.`);
      }
    }

    const out = [], coverage = {};
    for (let k = 0; k < terms.length; k++) {
      const keep = [], rejected = [];
      for (const c of found[k]) {
        const o = onts[c.ontology] || reg[c.ontology] || {};
        c.pref = o.pref ?? -1;
        c.tier = ontologyTier(c.ontology, o);
        c.ontologyTaxon = o.taxonLabel || null;
        if (c.outside) {
          [c.status, c.note] = ["outside", `${c.prefix} covers ${o.taxonLabel || "unspecified taxa"}, outside this specimen's lineage.`];
        } else if (c.ontology === "uberon") {
          [c.status, c.note] = await classify(c, anchor, lineageIds, constraints);
        } else {
          [c.status, c.note] = ["ontology", `${c.prefix} covers ${o.taxonLabel}.`];
        }
        (c.status === "incompatible" ? rejected : keep).push(c);
      }
      keep.sort(compareCandidates);
      const auto = keep.find((c) => c.match !== "partial" && AUTO_OK.has(c.status) && !c.outside);
      const direct = new Set(keep.filter((c) => c.match !== "partial" && !c.outside && AUTO_OK.has(c.status)).map((c) => c.ontology));
      for (const oid of direct) coverage[oid] = (coverage[oid] || 0) + 1;
      out.push({ term: terms[k], candidates: keep, rejected, autoPick: auto ? auto.iri : null });
    }
    const cov = Object.entries(coverage).sort((a, b) => b[1] - a[1]).map(([id, count]) =>
      ({ ontology: id, prefix: onts[id]?.prefix || id.toUpperCase(), taxonLabel: onts[id]?.taxonLabel || null, count }));
    return { ok: true, terms: out, coverage: cov, searched: inside, includeOutside, warnings };
  }

  return { resolveName, lookupTerms };
})();
