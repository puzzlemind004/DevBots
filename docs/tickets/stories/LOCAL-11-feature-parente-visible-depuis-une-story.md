---
source: "local"
source_id: "LOCAL-11"
parent: "LOCAL-F2"
created_at: "2026-10-23T14:00:00.000Z"
title: "Montrer la feature parente d'une story et y mener d'un clic"
state: "open"
---

# Montrer la feature parente d'une story et y mener d'un clic

## Description

Hors de New, une story ne dit plus à quelle feature elle appartient : seul
son frontmatter porte `parent`. Sur la carte d'une story, la feature parente
doit être visible et cliquable.

- Dans le panneau (`src/ui/flowTree.ts`), l'infobulle d'une story nomme sa feature (id et titre), avec un lien qui ouvre sa fiche ; la description de l'élément peut porter l'id de la feature dans les groupes Ready, En dev, À valider et Done.
- Un menu contextuel « Ouvrir la feature » sur une story qui en a une.
- Dans l'atelier de planification (`src/ui/planningPanel.ts`), l'en-tête nomme la feature, avec un lien vers sa fiche.

Une story dont le `parent` ne correspond à aucune fiche de `features/` n'affiche
rien de plus (pas de lien mort). `WorkDir.findFeature` fait déjà la
correspondance.

## Critères d'acceptation

- L'infobulle d'une story qui a une feature nomme cette feature et permet d'ouvrir sa fiche.
- Le menu contextuel « Ouvrir la feature » ouvre la fiche de la feature ; il n'apparaît pas pour une story sans feature.
- L'atelier de planification d'une story de feature nomme la feature et ouvre sa fiche d'un clic.
- Une story dont le parent n'a pas de fiche n'affiche ni lien ni menu.
- Les stories sans feature s'affichent comme avant.
