---
source: "local"
source_id: "LOCAL-10"
parent: "LOCAL-F2"
created_at: "2026-10-23T14:00:00.000Z"
title: "Montrer chaque feature avec toutes ses stories et son avancement"
state: "open"
---

# Montrer chaque feature avec toutes ses stories et son avancement

## Description

Dans le panneau (`src/ui/flowTree.ts`), une feature n'apparaît que dans New,
avec ses seules stories de New (« Seules ses stories de New sont rangées
ici »). Dès qu'une story passe en Ready, en dev ou en Done, elle quitte la
feature : rien ne montre l'arborescence feature → stories, ni où en est la
feature.

Évolution : une vue des features, où chacune montre **toutes** ses stories,
quel que soit leur état (New, Ready, En dev, À valider, Done), avec l'état de
chaque story et l'avancement de la feature, par exemple « 1/3 terminées ».

Forme à décider à la planification, par exemple :

- un groupe « Features » en tête du panneau `devbots.flow` ;
- ou une seconde vue dans le même conteneur.

Les groupes actuels par état restent tels quels : c'est le tableau de bord du
flux. Ouvrir une feature affiche sa fiche (critères compris, LOCAL-7), comme
aujourd'hui avec `devbots.openStory`. Les features locales et importées sont
traitées de la même façon.

L'état d'une story se lit dans son dossier (`new/`, `ready/`, `done/`) et dans
`state.json`, comme le fait déjà `groups()` de `FlowTreeProvider`. Une story
« terminée » est une story de `done/`.

## Critères d'acceptation

- Chaque feature de `.work/features/` apparaît avec toutes ses stories, quel que soit leur dossier ou leur état dans `state.json`.
- Chaque story affiche son état : New, en atelier, Ready, En dev, Bloquée, À valider, Done.
- Chaque feature affiche son avancement, par exemple « 1/3 terminées ».
- Une feature sans story reste visible, avec la mention « aucune story ».
- Ouvrir une feature affiche sa fiche ; ouvrir une story garde le comportement actuel (fiche, menus contextuels selon son état).
- Les groupes New, Ready, En dev, À valider et Done fonctionnent comme avant.
- La vue se met à jour quand une story change d'état (même rafraîchissement que le reste du panneau).
- Tests unitaires de la construction de l'arbre et du calcul de l'avancement.
