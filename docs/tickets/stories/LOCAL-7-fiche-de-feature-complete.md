---
source: "local"
source_id: "LOCAL-7"
parent: "LOCAL-F2"
created_at: "2026-10-23T14:00:00.000Z"
title: "Fiche de feature complète : critères, champs configurés, dépendances, pièces jointes"
state: "open"
dependencies:
  - "LOCAL-3"
---

# Fiche de feature complète : critères, champs configurés, dépendances, pièces jointes

## Description

`renderImportedFeatureCard` (`src/core/storyCard.ts`) n'écrit que le titre et
la description. Or une feature porte le contexte commun et les **critères
globaux** que ses stories, ensemble, doivent satisfaire. Pour 46491 « Gestion
des CNILs », on perd ses critères CA1 à CA5.

La fiche de `.work/features/` d'une feature importée contient désormais, comme
une story :

- la description ;
- les **critères d'acceptation**, sous `## Critères d'acceptation` ;
- les champs configurés pour le niveau `feature` dans `devbots.azureDevOps.fields` (LOCAL-2, LOCAL-3), rôles compris ;
- la section « Autres champs » si LOCAL-4 est livrée ;
- les dépendances déclarées et les pièces jointes.

Le plus simple est sans doute de partager le corps de `renderStoryCard`, avec
le frontmatter de feature (`FeatureFrontmatter`, `level: "feature"`). Le texte
de repli des critères d'une feature n'est pas celui d'une story (« À extraire à
la planification » n'a pas de sens : une feature ne se planifie pas) :
proposer par exemple « _Aucun critère dans la source._ ».

La liste des stories enfants est LOCAL-8.

Côté GitHub, une issue parente devenue feature n'a pas de critères séparés :
vérifier que sa fiche ne change pas, ou limiter le changement à Azure si c'est
plus sûr.

Mettre à jour `docs/format-fiches.md` (section « Fiches de feature »).

## Critères d'acceptation

- La fiche de feature d'un work item Azure contient `## Description` puis `## Critères d'acceptation` avec les critères de la source.
- Une feature sans critères dans la source affiche un texte de repli propre aux features, sans « À extraire à la planification ».
- Les champs configurés pour le niveau `feature` apparaissent dans la fiche de feature, et ceux du niveau `story` n'y apparaissent pas.
- Les dépendances déclarées et les pièces jointes de la feature apparaissent comme pour une story.
- Une révision nouvelle de la feature réécrit sa fiche sur place, sans marquage « à revoir », comme aujourd'hui.
- Les features locales `LOCAL-F…` et les fiches de feature GitHub ne changent pas.
- L'atelier de planification d'une story enfant reçoit la fiche complétée (le chemin passé via `featureFile` ne change pas).
- Tests unitaires du gabarit de feature : avec et sans critères, avec champs configurés, avec dépendances et pièces jointes.
