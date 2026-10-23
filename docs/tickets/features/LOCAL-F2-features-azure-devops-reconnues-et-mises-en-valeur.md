---
source: "local"
source_id: "LOCAL-F2"
level: "feature"
created_at: "2026-10-23T14:00:00.000Z"
title: "Features Azure DevOps reconnues et mises en valeur"
---

# Features Azure DevOps reconnues et mises en valeur

## Description

Bug constaté : l'import de la feature Azure 46491 « Gestion des CNILs » et de
ses stories 48012, 48013 et 48014 range 46491 dans `.work/new/` comme une
story, à côté de ses enfants, et laisse `.work/features/` vide. La feature peut
alors être planifiée et développée.

Cause : `levelForType` (`src/sources/azureDevOps.ts`) ne reconnaît que les
types nommés exactement « Epic » et « Feature ». Un type personnalisé tombe
en story, et `storyGroups` (`src/core/mergeTrees.ts`) ne le retient pas
comme feature.

Même reconnue, une feature importée ne garde que son titre et sa description
(`renderImportedFeatureCard`, `src/core/storyCard.ts`). Elle perd ses critères
d'acceptation, qui fixent le résultat attendu de l'ensemble de ses stories,
ainsi que les autres champs de son formulaire et la liste de ses stories.

La feature :

- reconnaît le niveau par les catégories de backlog Azure, avec un réglage
  pour forcer la correspondance ;
- complète la fiche de feature : critères, champs configurés pour le niveau
  `feature` (voir LOCAL-F1), dépendances, pièces jointes, liste des stories ;
- corrige à la synchro les imports déjà faits ;
- montre l'arbre feature → stories, avec l'avancement, dans le panneau ;
- donne la fiche de la feature comme contexte au dev et à la supervision.

Demande complète : `evol/devbots-evolution-features-azure.md` (hors git).

## Critères d'acceptation

1. Une feature d'un type personnalisé rattaché à `Microsoft.FeatureCategory` est rangée dans `.work/features/`, sans aucun réglage.
2. Le réglage `devbots.azureDevOps.workItemTypes` l'emporte sur les catégories.
3. Un type non reconnu donne une story et un avertissement qui nomme le type.
4. La fiche de feature contient la description, les critères d'acceptation, les champs configurés pour le niveau `feature` et la liste des stories enfants.
5. Une feature ne peut être ni planifiée ni développée.
6. Le panneau montre l'arbre feature → stories, avec l'état des stories et l'avancement de la feature.
7. Planifier, développer ou superviser une story enfant transmet la fiche de sa feature à l'agent.
8. À la synchro, une ancienne carte story reconnue comme feature passe dans `.work/features/` si elle n'a pas été démarrée ; sinon un avertissement est affiché.
9. Les features locales (`LOCAL-F…`) et le connecteur GitHub fonctionnent comme avant.
