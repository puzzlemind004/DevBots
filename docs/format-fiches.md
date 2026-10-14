# Format des fiches

Une fiche par story, dans `.work/new`, `.work/ready` ou `.work/done`. Le format
ne change pas : les skills existants continuent de les lire. Les features,
importées ou saisies à la main, ont leur propre fiche, dans `.work/features`.

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

`source_rev`, `imported_at` et `web_url` n'existent que pour une fiche importée.

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

## Fiches saisies à la main

Les commandes « nouvelle story » et « nouvelle feature » écrivent une fiche
pré-remplie et l'ouvrent dans l'éditeur. Les sections à remplir portent une
mention en italique « _À compléter : …_ » : l'atelier n'y voit aucun critère,
et la commande de planification prévient tant qu'il en reste une.

### Story locale

Dans `.work/new`, nommée `LOCAL-<n>-<slug>.md` :

```markdown
---
source: "local"
source_id: "LOCAL-3"
parent: "LOCAL-F1"
created_at: "2026-10-13T08:00:00.000Z"
title: "Valider le format de l'email"
state: "open"
---

# Valider le format de l'email

## Description

_À compléter : le besoin, pour qui, et pourquoi._

## Critères d'acceptation

_À compléter : un critère vérifiable par élément de liste._
```

`parent` vaut `null` pour une story sans feature. Des dépendances s'ajoutent à
la main avec un champ `dependencies`, comme pour une fiche importée.

### Feature

Dans `.work/features`, nommée `LOCAL-F<n>-<slug>.md` :

```markdown
---
source: "local"
source_id: "LOCAL-F1"
level: "feature"
created_at: "2026-10-13T08:00:00.000Z"
title: "Inscription par email"
---

# Inscription par email

## Description

_À compléter : l'objectif de la feature et le contexte commun à ses stories._
```

Une fiche locale n'a pas de source : la resynchronisation ne la touche jamais.

### Fiche née du tri

La supervision crée aussi des fiches `LOCAL-<n>`, rangées sous la feature de
la story d'origine (voir [Dev et supervision](dev-et-supervision.md#tri-des-problèmes)).
Leur frontmatter dit d'où elles viennent :

```yaml
origin: "pre-pr-check"
origin_story: "42"
```

Une fiche simple arrive directement dans `ready/`, avec une section
`## Mini-plan`, `recommended_model: "haiku"` et le fichier concerné dans
`files`. Une fiche complexe arrive dans `new/` et passe par l'atelier.

### Fiche passée dans Done hors du flux

Une story « déjà faite » (voir
[Dev et supervision](dev-et-supervision.md#déjà-fait)) arrive dans `done/`
sans merge. Son frontmatter le dit :

```yaml
done_outside: "verified"
done_at: "2026-10-14T10:00:00.000Z"
done_note: "branche feature/login"
```

| Champ | Rôle |
| --- | --- |
| `done_outside` | `direct` : sur ta parole. `verified` : après confirmation par l'agent de vérification |
| `done_at` | Date du passage dans Done |
| `done_note` | Ton indication sur l'endroit où trouver le travail, si tu en as donné une |

## Fiches de feature

Une feature ne passe pas par le flux : elle ne se planifie pas et ne bouge pas
de dossier. Le panneau range sous elle les stories de New dont le `parent` est
son identifiant, et l'atelier donne sa fiche à Claude comme contexte.

À l'import, tout ticket qui est le **parent direct d'une story importée**
devient une fiche de `.work/features`, nommée `<source_id>-<slug>.md` : une
feature Azure DevOps, une issue GitHub qui porte des sub-issues, ou un epic
dont dépendent directement des stories. Un epic qui ne contient que des
features ne laisse pas de fiche. Chez Azure DevOps, une story choisie seule
vient avec sa feature parente, sans les autres stories de celle-ci.

```markdown
---
source: "azureDevOps"
source_id: "30"
level: "feature"
source_rev: "7"
parent: "12"
imported_at: "2026-10-13T08:00:00.000Z"
title: "Inscription par email"
state: "Active"
web_url: "https://dev.azure.com/acme/web/_workitems/edit/30"
---

# Inscription par email

## Description

...

---

[Ouvrir dans la source](...)
```

Une feature ne porte ni plan ni échange : quand sa révision change, l'import
la réécrit sur place, sans marquage « à revoir ».

## Resynchronisation

À chaque import, et à chaque resynchronisation, une story déjà connue est
comparée par sa **révision** : tout changement compte, un commentaire GitHub
compris, puisqu'il apporte souvent une précision.

| Situation | Effet |
| --- | --- |
| Inconnue | Fiche écrite dans `new/`, référence gardée dans `.work/sources/<id>.md` |
| Connue, même révision | Rien |
| Connue, encore dans `new/`, révision nouvelle | Fiche réécrite sur place |
| Connue, déjà dans `ready/` ou `done/`, révision nouvelle | Marquée `needs_review: true`, **contenu intact** |

Le dernier cas est le plus important : une story déjà planifiée a un plan et des
échanges attachés. L'extension ajoute `needs_review: true` et
`source_rev_seen: <nouvelle révision>` au frontmatter, sans toucher au corps, et
range la version reçue dans `.work/sources/<id>.incoming.md`. Le panneau
l'affiche « à revoir », et c'est toi qui tranches (voir
[Resynchronisation](resynchronisation.md)).

La référence ne sert qu'à montrer la différence. Une story importée avant que
`.work/sources/` existe n'en a pas : elle s'écrit au premier passage où la
révision n'a pas bougé ; d'ici là, le diff part de la fiche elle-même.
