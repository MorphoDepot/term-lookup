// Term lookup prototype (SlicerMorphoDepot #237) -- page logic. The lookup itself is in lookup.js.
const $ = (s) => document.querySelector(s);
const GENERIC = { scheme: "SCT", code: "85756007", meaning: "Tissue" };
const ANATOMICAL_STRUCTURE = { scheme: "SCT", code: "123037004", meaning: "Anatomical Structure" };
const CSV_HEADER = "LabelValue,Name,Color_R,Color_G,Color_B,Color_A,Category_CodingScheme,Category_CodeValue,Category_CodeMeaning,Type_CodingScheme,Type_CodeValue,Type_CodeMeaning,TypeModifier_CodingScheme,TypeModifier_CodeValue,TypeModifier_CodeMeaning,Region_CodingScheme,Region_CodeValue,Region_CodeMeaning,RegionModifier_CodingScheme,RegionModifier_CodeValue,RegionModifier_CodeMeaning";
const VALID_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

let species = null;   // TermLookup.resolveName result
let lookupMeta = null; // TermLookup.lookupTerms result (or {nonBiological:true})
let rows = [];        // {name, color, candidates, rejected, auto, choice}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ------------------------------------------------------------------ colors
// Slicer's built-in "Labels" color table (vtkMRMLColorTableNode::SetTypeToLabels): values 1-10 are
// fixed (jake, Peach, Brain, Ventricles, ...), then 11-256 repeat a 10-color cycle (jake, elwood,
// gato, avery, mambazo, domino, monk, forest, dylan, kales). RGB as Slicer exports it to CSV.
const LABELS_FIRST = ["#3380cc", "#ffccb3", "#ffffff", "#66b3ff", "#e68080", "#80e680", "#80e6e6", "#e6e680", "#e6b3e6", "#e6e680"];
const LABELS_CYCLE = ["#3380cc", "#33cc80", "#cc8033", "#cc3380", "#8033cc", "#80cc33", "#3333cc", "#cccc33", "#33cccc", "#808080"];
const palette = (i) => (i < 10 ? LABELS_FIRST[i] : LABELS_CYCLE[(i - 10) % 10]); // i = label value - 1
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// ------------------------------------------------------------------ step 1
function updateLookupEnabled() {
  $("#lookupBtn").disabled = !($("#nonbio").checked || (species && species.ok));
}

async function resolveSpecies() {
  const name = $("#species").value.trim();
  if (!name) return;
  $("#resolveBtn").disabled = true;
  $("#speciesOut").innerHTML = `<div class="box info"><span class="spinner"></span>Looking up “${esc(name)}” in GBIF and NCBI…</div>`;
  try {
    species = await TermLookup.resolveName(name);
  } catch (e) {
    species = { ok: false, error: e.message || String(e) };
  }
  $("#resolveBtn").disabled = false;
  renderSpecies();
  updateLookupEnabled();
}

function renderSpecies() {
  const sp = species;
  if (!sp.ok) { $("#speciesOut").innerHTML = `<div class="box err">${esc(sp.error)}</div>`; return; }
  const g = sp.gbif, a = sp.ncbi;
  const gbifMatch = g.matchType === "EXACT" ? "exact match" : g.matchType === "FUZZY" ? "close spelling match — check it" : "matched to a higher group";
  let synonym = "";
  if (g.status === "SYNONYM" || g.status === "HETEROTYPIC_SYNONYM" || g.status === "HOMOTYPIC_SYNONYM")
    synonym = `<div class="box warn">GBIF treats this name as a synonym of <i>${esc(g.species || "")}</i>; the accepted name is used for the lineage.</div>`;
  let ncbiLine;
  if (!a) ncbiLine = `<span class="bad">NCBI knows none of this group's names, so no ontology can be chosen.</span>`;
  else if (a.exact) ncbiLine = `<i>${esc(a.name)}</i> (${esc(a.rank)}) — found directly`;
  else ncbiLine = `NCBI does not list the name itself; placed via its ${esc(a.via)} <i>${esc(a.name)}</i>. Terms restricted to groups below ${esc(a.name)} are shown but flagged as unverified.`;
  const clades = a ? a.lineage.filter((x) => x.name !== "cellular organisms").map((x) => esc(x.name)).join(" › ") : "";
  const matched = sp.ontologies.filter((o) => o.status === "matched");
  const chips = matched.map((o) => `<span class="chip${o.taxonSource === "override" ? " ov" : ""}" title="${esc(o.title)}${o.note ? " — " + esc(o.note) : ""}"><b>${esc(o.prefix)}</b> · ${esc(o.taxonLabel)}${o.taxonSource === "override" ? " (our override)" : ""}</span>`).join("");
  const none = matched.length ? "" : `<div class="box warn">No anatomy ontology covers this group. Every name will fall back to generic unless you tick “also list matches from ontologies outside this taxon”.</div>`;
  $("#speciesOut").innerHTML = `${synonym}
    <dl class="kv">
      <dt>GBIF</dt><dd><b>${esc(g.scientificName)}</b> · ${esc((g.rank || "").toLowerCase())} · ${gbifMatch}<div class="path">${g.lineage.map((x) => esc(x.name)).join(" › ")}</div></dd>
      <dt>NCBI</dt><dd>${ncbiLine}${a ? `<details><summary>Clade path used for taxon checks</summary><div class="path">${clades}</div></details>` : ""}</dd>
      <dt>Ontologies</dt><dd><div class="chips">${chips || "—"}</div></dd>
    </dl>${none}`;
}

// ------------------------------------------------------------------ step 2
function readTerms() {
  const seen = new Set(), out = [];
  for (const line of $("#terms").value.split("\n")) {
    const t = line.trim();
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out;
}

async function lookup() {
  const terms = readTerms();
  if (!terms.length) { $("#lookupStatus").innerHTML = `<div class="box warn">Enter at least one name.</div>`; return; }
  if ($("#nonbio").checked) {
    lookupMeta = { nonBiological: true, warnings: [], coverage: [] };
    rows = terms.map((t, i) => ({ name: t, color: palette(i), candidates: [], rejected: [], auto: "generic", choice: "generic" }));
    $("#lookupStatus").innerHTML = "";
    return renderResults();
  }
  $("#lookupBtn").disabled = true;
  $("#lookupStatus").innerHTML = `<div class="box info"><span class="spinner"></span>Searching ${terms.length} name${terms.length > 1 ? "s" : ""} in ${species.ontologies.filter((o) => o.status === "matched").map((o) => o.prefix).join(", ") || "no ontologies"} and checking taxon limits…</div>`;
  const progress = (msg) => { $("#lookupStatus").innerHTML = `<div class="box info"><span class="spinner"></span>${esc(msg)}</div>`; };
  let out;
  try {
    out = await TermLookup.lookupTerms(terms, species, $("#outside").checked, progress);
  } catch (e) {
    out = { ok: false, error: e.message || String(e) };
  }
  updateLookupEnabled();
  if (!out.ok) { $("#lookupStatus").innerHTML = `<div class="box err">${esc(out.error)}</div>`; return; }
  $("#lookupStatus").innerHTML = "";
  lookupMeta = out;
  rows = out.terms.map((t, i) => ({ name: t.term, color: palette(i), candidates: t.candidates, rejected: t.rejected,
    auto: t.autoPick || "generic", choice: t.autoPick || "generic" }));
  renderResults();
}

// ------------------------------------------------------------------ step 3
const chosen = (r) => r.candidates.find((c) => c.iri === r.choice) || null;

function rowState(r) {
  if (lookupMeta.nonBiological) return ["non-biological", "Generic", "grey"];
  if (r.choice !== "generic") {
    const c = chosen(r);
    if (r.choice === r.auto) return ["matched", c && c.status === "unrestricted" ? "Matched (no taxon limit)" : "Matched", "ok"];
    return ["user-selected", "Your pick", "info"];
  }
  if (r.auto !== "generic") return ["reverted-to-generic", "Reverted to generic", "warn"];
  if (r.candidates.length) return ["suggestions-not-used", "Review suggestions", "warn"];
  return ["no-match", "No match", "grey"];
}

function optionText(c) {
  const bits = [`${c.label} — ${c.oboId || c.prefix}`];
  if (c.match === "synonym") bits.push("(synonym match)");
  if (c.match === "partial") bits.push("(partial match)");
  if (c.status === "unverified") bits.push("⚠ taxon unverified");
  if (c.status === "outside") bits.push("⚠ outside taxon");
  return bits.join("  ");
}

function rowHtml(r, i) {
  const good = r.candidates.filter((c) => c.match !== "partial" && c.status !== "outside");
  const other = r.candidates.filter((c) => !good.includes(c));
  const opt = (c) => `<option value="${esc(c.iri)}"${c.iri === r.choice ? " selected" : ""}>${esc(optionText(c))}</option>`;
  const select = lookupMeta.nonBiological ? `<select disabled><option>Generic — Tissue (SCT 85756007)</option></select>` : `<select class="choice" data-i="${i}">
      ${good.length ? `<optgroup label="Matches">${good.map(opt).join("")}</optgroup>` : ""}
      ${other.length ? `<optgroup label="Other suggestions — check carefully">${other.map(opt).join("")}</optgroup>` : ""}
      <option value="generic"${r.choice === "generic" ? " selected" : ""}>Generic — Tissue (SCT 85756007)</option>
    </select>`;
  const c = chosen(r);
  let detail = "";
  if (c) {
    const olsUrl = `https://www.ebi.ac.uk/ols4/ontologies/${encodeURIComponent(c.ontology)}/classes/${encodeURIComponent(encodeURIComponent(c.iri))}`;
    detail = `${c.definition ? esc(c.definition.length > 240 ? c.definition.slice(0, 240) + "…" : c.definition) + " " : ""}<a href="${olsUrl}" target="_blank" rel="noopener">View in OLS</a><span class="note">${esc(c.note)}</span>`;
  } else if (!lookupMeta.nonBiological) {
    const [state] = rowState(r);
    detail = {
      "no-match": "No term in the ontologies for this taxon matched this name.",
      "reverted-to-generic": "You chose the generic term over the suggested match.",
      "suggestions-not-used": `Only partial or unverified suggestions (${r.candidates.length}). Pick one if it fits, or keep generic.`,
    }[state] || "";
  }
  let actions = "";
  if (!lookupMeta.nonBiological) {
    if (r.choice !== "generic") actions = `<button class="link" data-act="generic" data-i="${i}">Use generic instead</button>`;
    else if (r.auto !== "generic") actions = `<button class="link" data-act="restore" data-i="${i}">Restore suggested match</button>`;
  }
  const rej = r.rejected.length ? `<details class="rej"><summary>${r.rejected.length} match${r.rejected.length > 1 ? "es" : ""} rejected for this taxon</summary><ul>${r.rejected.map((x) => `<li>${esc(x.label)} — ${esc(x.oboId)}: ${esc(x.note)}</li>`).join("")}</ul></details>` : "";
  const [, label, cls] = rowState(r);
  return `<td class="num">${i + 1}</td>
    <td><input type="color" class="color" data-i="${i}" value="${r.color}"></td>
    <td><input type="text" class="name" data-i="${i}" value="${esc(r.name)}" spellcheck="false"></td>
    <td>${select}<div class="detail">${detail}</div>${actions ? `<div class="detail">${actions}</div>` : ""}${rej}</td>
    <td><span class="badge ${cls}">${label}</span></td>`;
}

function renderSummary() {
  const counts = {};
  rows.forEach((r) => { const [s, label, cls] = rowState(r); counts[s] = counts[s] || { n: 0, label, cls }; counts[s].n++; });
  const parts = Object.values(counts).map((c) => `<span><span class="badge ${c.cls}">${esc(c.label)}</span> ${c.n}</span>`);
  let html = `<div class="summary">${parts.join("")}</div>`;
  if (lookupMeta.coverage && lookupMeta.coverage.length)
    html += `<p class="hint">Names with a direct match, by ontology: ${lookupMeta.coverage.map((c) => `<b>${esc(c.prefix)}</b> ${c.count}/${rows.length}`).join(" · ")}</p>`;
  (lookupMeta.warnings || []).forEach((w) => { html += `<div class="box warn">${esc(w)}</div>`; });
  $("#summary").innerHTML = html;
}

function renderResults() {
  $("#step3").hidden = false;
  $("#step4").hidden = false;
  $("#results tbody").innerHTML = rows.map((r, i) => `<tr>${rowHtml(r, i)}</tr>`).join("");
  renderSummary();
  renderExport();
}

function rerenderRow(i) {
  $("#results tbody").rows[i].innerHTML = rowHtml(rows[i], i);
  renderSummary();
  renderExport();
}

$("#results").addEventListener("change", (e) => {
  const i = +e.target.dataset.i;
  if (e.target.classList.contains("choice")) { rows[i].choice = e.target.value; rerenderRow(i); }
});
$("#results").addEventListener("input", (e) => {
  const i = +e.target.dataset.i;
  if (e.target.classList.contains("name")) { rows[i].name = e.target.value; renderExport(); }
  if (e.target.classList.contains("color")) { rows[i].color = e.target.value; renderExport(); }
});
$("#results").addEventListener("click", (e) => {
  const act = e.target.dataset.act, i = +e.target.dataset.i;
  if (act === "generic") { rows[i].choice = "generic"; rerenderRow(i); }
  if (act === "restore") { rows[i].choice = rows[i].auto; rerenderRow(i); }
});

// ------------------------------------------------------------------ step 4
const csvField = (v) => { v = String(v ?? ""); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };

function codesFor(r) {
  const c = chosen(r);
  if (!c) return [GENERIC, GENERIC];
  return [ANATOMICAL_STRUCTURE, { scheme: c.prefix, code: c.iri, meaning: c.label }];
}

function buildCsv() {
  const lines = [CSV_HEADER];
  rows.forEach((r, i) => {
    const [R, G, B] = hexToRgb(r.color), [cat, type] = codesFor(r);
    lines.push([i + 1, r.name, R, G, B, 255, cat.scheme, cat.code, cat.meaning, type.scheme, type.code, type.meaning,
      "", "", "", "", "", "", "", "", ""].map(csvField).join(","));
  });
  return lines.join("\n") + "\n";
}

function buildProvenance() {
  const sp = species;
  return {
    tool: "MorphoDepot term-lookup prototype (SlicerMorphoDepot #237)",
    generated: new Date().toISOString(),
    colorTable: `${$("#tableName").value.trim()}.csv`,
    specimen: lookupMeta.nonBiological ? { nonBiological: true } : {
      input: sp.input,
      gbif: { scientificName: sp.gbif.scientificName, rank: sp.gbif.rank, status: sp.gbif.status, matchType: sp.gbif.matchType,
              usageKey: sp.gbif.usageKey, acceptedUsageKey: sp.gbif.acceptedUsageKey, lineage: sp.gbif.lineage },
      ncbi: sp.ncbi ? { name: sp.ncbi.name, taxid: sp.ncbi.taxid, rank: sp.ncbi.rank, placedVia: sp.ncbi.via, exact: sp.ncbi.exact } : null,
      ontologiesSearched: sp.ontologies.filter((o) => o.status === "matched").map((o) => ({ id: o.id, taxon: o.taxon, taxonLabel: o.taxonLabel, taxonSource: o.taxonSource })),
      includedOutsideTaxon: !!lookupMeta.includeOutside,
    },
    rows: rows.map((r, i) => {
      const c = chosen(r), auto = r.candidates.find((x) => x.iri === r.auto);
      return {
        label: i + 1, name: r.name, status: rowState(r)[0],
        term: c ? { ontology: c.ontology, id: c.oboId, iri: c.iri, label: c.label, match: c.match, taxonStatus: c.status, taxonNote: c.note }
                : { generic: true, scheme: GENERIC.scheme, code: GENERIC.code, meaning: GENERIC.meaning },
        suggested: auto ? { id: auto.oboId, label: auto.label } : null,
        suggestionsAvailable: r.candidates.length,
        rejectedForTaxon: r.rejected.map((x) => ({ id: x.oboId, label: x.label, reason: x.note })),
      };
    }),
  };
}

function renderExport() {
  const ok = VALID_NAME.test($("#tableName").value.trim());
  $("#nameHint").classList.toggle("bad", !ok);
  $("#csvBtn").disabled = $("#provBtn").disabled = !ok;
  $("#csvPreview").textContent = buildCsv();
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------------ wiring
$("#resolveBtn").addEventListener("click", resolveSpecies);
$("#species").addEventListener("keydown", (e) => { if (e.key === "Enter") resolveSpecies(); });
$("#species").addEventListener("input", () => { species = null; $("#speciesOut").innerHTML = ""; updateLookupEnabled(); });
$("#nonbio").addEventListener("change", () => {
  const nb = $("#nonbio").checked;
  $("#species").disabled = $("#resolveBtn").disabled = $("#outside").disabled = nb;
  species = null;
  $("#speciesOut").innerHTML = nb ? `<div class="box info">No taxonomy lookup. Every segment gets the generic term SCT 85756007 “Tissue”.</div>` : "";
  updateLookupEnabled();
});
$("#lookupBtn").addEventListener("click", lookup);
$("#tableName").addEventListener("input", renderExport);
$("#csvBtn").addEventListener("click", () => download(`${$("#tableName").value.trim()}.csv`, buildCsv(), "text/csv"));
$("#provBtn").addEventListener("click", () => download(`${$("#tableName").value.trim()}.provenance.json`, JSON.stringify(buildProvenance(), null, 2), "application/json"));

// Shareable test links: ?species=Chelydra+serpentina&terms=carapace|plastron (&nonbio=1, &outside=1)
(async () => {
  const p = new URLSearchParams(location.search);
  if (p.get("terms")) $("#terms").value = p.get("terms").split("|").join("\n");
  if (p.get("outside")) $("#outside").checked = true;
  if (p.get("nonbio")) { $("#nonbio").checked = true; $("#nonbio").dispatchEvent(new Event("change")); }
  else if (p.get("species")) { $("#species").value = p.get("species"); await resolveSpecies(); }
  if (p.get("terms") && ((species && species.ok) || $("#nonbio").checked)) await lookup();
})();
