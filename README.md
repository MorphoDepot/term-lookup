# Color-table term lookup

**Prototype**: https://morphodepot.github.io/term-lookup/

This tool builds a 3D Slicer terminology color table from a list of segment names. You enter a species
and the names. For each name, the tool proposes a term from an anatomy ontology that covers that species.
You review the proposals, keep or change each one, or revert any row to the generic term. Then you
download the color table.

It was built for [SlicerMorphoDepot#237](https://github.com/SlicerMorph/SlicerMorphoDepot/issues/237).
Please leave feedback there.

## How it decides

Everything runs in your browser. The page queries these public services directly, and nothing you type
is stored.

1. **GBIF** recognizes the name (a species or any higher group) and gives its lineage.
2. **NCBI Taxonomy** supplies the higher groups, such as Vertebrata, Tetrapoda and Testudines, that
   ontologies and Uberon's taxon rules are written in. GBIF only has kingdom, phylum, class, order,
   family and genus. The tool walks up the GBIF lineage to the lowest name NCBI knows. A fossil missing
   from NCBI is placed through its genus, family or higher group, and the page says so.
3. **Ontologies** are chosen when the group of organisms they cover is in that lineage. That coverage
   comes from the [OBO Foundry registry](https://obofoundry.org). Where the registry leaves it blank,
   `ontology_taxa_overrides.json` fills it in.
4. **OLS** (EBI's ontology search) searches each name in those ontologies. Only the ontology that
   defines a term counts. Matches can be exact (label or synonym) or partial.
5. **Ubergraph** checks each Uberon match against the specimen. Carapace is limited to Testudines,
   mandible and heart to Vertebrata, and so on. Matches that don't apply to the specimen are rejected,
   and the page shows the reason.

A term is picked automatically only when it is an exact match (label or synonym) and valid for the
taxon. When several qualify, the ontology decides first:

1. clade ontologies, such as HAO and AISM for insects, PO for plants, SPD for spiders;
2. Uberon;
3. single-genus model-organism ontologies (MA, EMAPA, ZFA, XAO, FBbt, WBbt).

So a mouse "4th ventricle" gets Uberon's *fourth ventricle*, which matches through its synonym, rather
than MA's or EMAPA's *4th ventricle*. Uberon cross-references those terms (UBERON:0002422 lists
MA:0000196 and EMAPA:16917), so nothing is lost, and tables stay comparable across species. Within one
ontology, a label match beats a synonym match. The model-organism terms stay in the list as
alternatives.

Partial and unverified matches are listed but never picked automatically. Any row can be reverted to
the generic term SCT 85756007 "Tissue".

A non-biological specimen skips the lookup, and every row gets the generic term.

## Output

- **`<name>.csv`**: a Slicer terminology color table with the same 21 columns as the
  [terms-and-colors](https://github.com/SlicerMorph/terms-and-colors) tables. Matched rows use Category
  SCT 123037004 "Anatomical Structure" and Type = ontology prefix, term link and label. Generic rows use
  SCT 85756007 "Tissue" for both. Colors follow Slicer's built-in "Labels" table by label value, and
  each can be changed.
- **`<name>.provenance.json`**: for each row, whether the term was matched, picked by the user,
  reverted to generic, or had no match. It also records the specimen's GBIF and NCBI placement and the
  ontologies searched.

## Known limits

- The page depends on four outside services (GBIF, NCBI, OLS, Ubergraph). If Ubergraph is down, Uberon
  matches show as "unchecked".
- Some groups have no anatomy ontology, for example crustaceans and most molluscs. Their names fall back
  to generic unless Uberon has a term that fits.
- Uberon terms with no recorded taxon restriction are accepted.

## Test links

Links can fill in the form and run it, for example
`?species=Daphnia%20magna&terms=carapace|compound%20eye|heart` (add `&outside=1` or `&nonbio=1`).

## Run locally

    python3 -m http.server 8000

Then open http://127.0.0.1:8000. Any static file server works; opening `index.html` directly from disk
does not, because the page loads `ontology_taxa_overrides.json`.
