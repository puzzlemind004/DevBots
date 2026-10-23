---
source: "local"
source_id: "LOCAL-5"
parent: "LOCAL-F1"
created_at: "2026-10-23T14:00:00.000Z"
title: "Commande « lister les champs d'un work item Azure »"
state: "open"
dependencies:
  - "LOCAL-1"
---

# Commande « lister les champs d'un work item Azure »

## Description

Pour remplir `devbots.azureDevOps.fields`, il faut connaître les noms de
référence `Custom.*` des champs d'un formulaire. Aujourd'hui, il faut ouvrir
l'API REST dans le navigateur.

Nouvelle commande « DevBots : lister les champs d'un work item Azure » : elle
demande un id (même saisie qu'à l'import : `1234`, `#1234` ou une URL, voir
`parseWorkItemId`), lit le work item et affiche dans le canal de sortie
DevBots ses champs **non vides** : nom de référence, libellé, type (LOCAL-1),
et le début du contenu (une ligne, texte brut, tronqué).

La sortie se termine par un exemple de réglage `devbots.azureDevOps.fields`
pour le niveau du work item, prêt à copier, avec les champs HTML non lus par
défaut.

Disponible seulement quand `devbots.source.kind` vaut `azureDevOps` (sinon un
message le dit). Points d'entrée : `src/extension.ts` (enregistrement),
`package.json` (commande), un nouveau fichier dans `src/ui/`, README.

## Critères d'acceptation

- La commande apparaît dans la palette sous « DevBots : lister les champs d'un work item Azure ».
- Elle accepte un id, `#id` ou une URL de work item ; un id invalide donne le message d'erreur de `parseWorkItemId`.
- Le canal de sortie s'ouvre et liste, pour chaque champ non vide : nom de référence, libellé, type et début du contenu sur une ligne.
- Les champs vides ne sont pas listés.
- La sortie se termine par un exemple de réglage `devbots.azureDevOps.fields` pour le niveau du work item.
- Avec une source GitHub, la commande dit qu'elle ne concerne qu'Azure DevOps et ne fait rien d'autre.
- Un work item introuvable ou un accès refusé donne un message clair, sans trace technique brute.
