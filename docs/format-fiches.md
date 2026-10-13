# Format des fiches

Une fiche par story, dans `.work/new`, `.work/ready` ou `.work/done`. Le format
ne change pas : les skills existants continuent de les lire.

Nom du fichier : `<source_id>-<slug>.md`.

## Frontmatter

```markdown
---
source: "github"
source_id: "42"
source_rev: "2026-10-01T10:00:00Z"
parent: "30"
imported_at: "2026-10-13T08:00:00.000Z"
title: "Valider l'email à l'inscription"
state: "open"
web_url: "https://github.com/acme/web/issues/42"
dependencies:
  - "40"
story_points: 5
priority: 2
---
```

| Champ | Rôle |
| --- | --- |
| `source` | `github` ou `azureDevOps` |
| `source_id` | Identifiant chez la source. Obligatoire : une fiche sans lui est ignorée par le flux |
| `source_rev` | Révision ADO, ou date de dernière modification GitHub. Sert à la resynchronisation |
| `parent` | Parent chez la source, `null` à la racine |
| `imported_at` | Date de l'import, en ISO 8601 |
| `dependencies` | Identifiants des stories bloquantes, déclarés par la source |
| `story_points`, `priority` | Seulement quand la source les fournit |

Les valeurs sont toujours citées, pour qu'un titre commençant par un chiffre ou
contenant un deux-points ne change pas de type en YAML.

## Corps

```markdown
# <titre>

## Description
...

## Critères d'acceptation
...

## Dépendances déclarées
- Bloquée par : 40 — Créer le service

## Pièces jointes
- [capture.png](...)

---

[Ouvrir dans la source](...)
```

Une section vide porte une mention explicite plutôt que d'être absente : une
story GitHub sans critères affiche « à extraire à la planification ».

## Resynchronisation

À chaque import, une story déjà connue est comparée par sa révision.

| Situation | Effet |
| --- | --- |
| Inconnue | Fiche écrite dans `new/` |
| Connue, même révision | Rien |
| Connue, encore dans `new/` | Fiche réécrite sur place |
| Connue, déjà dans `ready/` ou `done/` | Marquée `needs_review: true`, **contenu intact** |

Le dernier cas est le plus important : une story déjà planifiée a un plan et des
échanges attachés. L'extension ajoute `needs_review: true` et
`source_rev_seen: <nouvelle révision>` au frontmatter, sans toucher au corps. Le
panneau l'affiche « à revoir », et c'est toi qui tranches.
