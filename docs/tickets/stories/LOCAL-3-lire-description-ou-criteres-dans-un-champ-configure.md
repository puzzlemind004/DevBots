---
source: "local"
source_id: "LOCAL-3"
parent: "LOCAL-F1"
created_at: "2026-10-23T14:00:00.000Z"
title: "Lire la description ou les critères d'acceptation dans un champ Azure configuré"
state: "open"
dependencies:
  - "LOCAL-2"
---

# Lire la description ou les critères d'acceptation dans un champ Azure configuré

## Description

Suite de LOCAL-2 : les entrées de `devbots.azureDevOps.fields` peuvent porter
un `role`, `"description"` ou `"acceptanceCriteria"`, qui **remplace** le champ
lu par défaut pour ce rôle (`System.Description`,
`Microsoft.VSTS.Common.AcceptanceCriteria`).

Cas d'origine : chez RayonVert, les critères CA1, CA2… du type « Story Front »
sont dans un champ `Custom.*` (« Que faire ? »). La planification ne les reçoit
pas et les invente à partir de l'objectif.

Règles :

- **Sans entrée de rôle**, les champs par défaut sont lus comme aujourd'hui.
- **Une entrée de rôle remplace le champ par défaut de ce rôle**, qui n'est plus lu, même s'il est rempli.
- **Ordre** : celui de la liste. Un rôle absent de la liste garde sa place par défaut : la description en premier, les critères en dernier.
- Les sections de rôle gardent leurs titres, `## Description` et `## Critères d'acceptation`, dont dépendent la planification, la détection des critères (`src/core/acceptance.ts`) et le texte de repli « _Aucun critère dans la source…_ ». `section` est ignoré pour une entrée de rôle.
- Plusieurs champs du même rôle sont concaténés dans l'ordre, chacun sous un sous-titre `###` portant son libellé Azure.
- Le texte de repli n'apparaît que si tous les champs du rôle sont vides.

Exemple attendu pour le work item 48012 « Afficher les CNILs » :

```jsonc
"story": [
  { "field": "Custom.PourQui", "section": "Pour qui ?" },
  { "field": "System.Description", "role": "description" },
  { "field": "Custom.QueFaire", "role": "acceptanceCriteria" }
]
```

donne, dans l'ordre : `## Pour qui ?`, `## Description`, `## Critères d'acceptation`
(CA1 et CA2 venus de `Custom.QueFaire`).

Le résultat attendu complet est dans `evol/devbots-evolution-champs-azure.md`.

## Critères d'acceptation

- Avec un rôle `acceptanceCriteria` configuré, la section « Critères d'acceptation » vient de ce champ, et `Microsoft.VSTS.Common.AcceptanceCriteria` n'est pas lu même s'il est rempli.
- Le texte « _Aucun critère dans la source. À extraire à la planification._ » n'apparaît que si le champ configuré est vide.
- Même chose pour le rôle `description` et `System.Description`, avec « _Aucune description dans la source._ ».
- Un rôle listé à une autre position que celle par défaut prend la place de la liste : l'exemple de 48012 donne Pour qui ?, Description, Critères d'acceptation, dans cet ordre.
- Un rôle non listé garde sa place par défaut : avec seulement `Custom.PourQui` sans rôle et `Custom.QueFaire` en `acceptanceCriteria`, l'ordre est Description, Pour qui ?, Critères d'acceptation.
- Deux champs avec le même rôle sont concaténés dans l'ordre de la liste, chacun sous un `###` portant son libellé Azure.
- Les critères lus dans un champ configuré sont reconnus par la planification comme des critères de la source (pas d'« extraction »).
- Tests unitaires de `toTicket` et `renderStoryCard` couvrant ces cas.
