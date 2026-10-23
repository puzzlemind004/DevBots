---
source: "local"
source_id: "LOCAL-2"
parent: "LOCAL-F1"
created_at: "2026-10-23T14:00:00.000Z"
title: "Ajouter à la fiche des sections tirées de champs Azure configurés"
state: "open"
dependencies:
  - "LOCAL-1"
---

# Ajouter à la fiche des sections tirées de champs Azure configurés

## Description

Nouveau réglage `devbots.azureDevOps.fields` : pour chaque niveau de carte
(`story`, `feature`, `epic`), une liste ordonnée de champs à ajouter à la fiche.

```jsonc
"devbots.azureDevOps.fields": {
  "story": [
    { "field": "Custom.PourQui", "section": "Pour qui ?" }
  ],
  "feature": []
}
```

| Propriété | Obligatoire | Rôle |
|---|---|---|
| `field` | oui | Nom de référence Azure du champ |
| `section` | non | Titre de la section. Par défaut : le libellé Azure du champ (LOCAL-1) |
| `role` | non | Traité par LOCAL-3 ; cette story ne gère que les entrées sans rôle |

Cette story couvre les entrées **sans rôle** : chacune devient une section `##`
de la fiche, après la description et avant les critères d'acceptation, dans
l'ordre de la liste. Elle pose aussi le modèle que LOCAL-3 étend : `Ticket`
(`src/core/model.ts`) ne connaît aujourd'hui que `description` et
`acceptanceCriteria`. Il faut lui ajouter des sections ordonnées, que
`renderStoryCard` (`src/core/storyCard.ts`) écrit. GitHub n'en produit pas.

Le niveau retenu est celui de la carte importée, donné par `levelForType`
(et, après LOCAL-6, par les catégories de backlog).

Règles :

- un champ HTML passe par `htmlToMarkdown` ; un champ texte simple est recopié tel quel (type lu via LOCAL-1) ;
- un champ vide ou absent du work item ne produit pas de section ;
- un `field` inconnu du type de work item donne **un seul** avertissement dans le canal de sortie DevBots par import ou synchro, sans bloquer l'import ;
- réglage absent, ou niveau absent du réglage : le comportement actuel.

Le réglage se déclare dans `package.json` (schéma JSON avec `field`, `section`,
`role`) et se lit dans `src/util/config.ts`. Documenter le réglage dans le
README et le format des sections dans `docs/format-fiches.md`.

## Critères d'acceptation

- Sans réglage, la fiche d'une story importée est identique à celle de la 0.5.0.
- Avec `{ "field": "Custom.PourQui", "section": "Pour qui ?" }` pour `story`, la fiche de la story contient `## Pour qui ?` avec le contenu du champ converti en Markdown, entre « Description » et « Critères d'acceptation ».
- Sans `section`, le titre est le libellé Azure du champ.
- Plusieurs champs sans rôle apparaissent dans l'ordre de la liste.
- Un champ configuré mais vide ou absent du work item ne produit pas de section.
- Un champ de type texte simple est recopié sans conversion HTML.
- La configuration `story` ne s'applique pas aux features, et inversement.
- Un nom de champ inconnu du type donne un seul avertissement dans le canal de sortie, même sur plusieurs work items, et l'import va au bout.
- Modifier dans Azure un champ configuré change la révision : la resynchronisation réécrit la fiche de `new/` avec la nouvelle section, ou marque « à revoir » une story de `ready/`, et `sources/<id>.incoming.md` contient la nouvelle section.
- Le connecteur GitHub et ses fiches ne changent pas.
- Tests unitaires de `toTicket` et `renderStoryCard` couvrant ces cas.
