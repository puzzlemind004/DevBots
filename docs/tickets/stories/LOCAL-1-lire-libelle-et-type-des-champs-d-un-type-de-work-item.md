---
source: "local"
source_id: "LOCAL-1"
parent: "LOCAL-F1"
created_at: "2026-10-23T14:00:00.000Z"
title: "Lire le libellé et le type des champs d'un type de work item Azure"
state: "open"
---

# Lire le libellé et le type des champs d'un type de work item Azure

## Description

Les réglages de champs (LOCAL-2, LOCAL-3), le repli « Autres champs » (LOCAL-4)
et la commande de diagnostic (LOCAL-5) ont besoin de deux informations sur chaque
champ d'un work item : son **libellé** dans le formulaire (« Pour qui ? ») et
son **type** (`html`, `string`, `plainText`…). Un texte riche se reconnaît à
son type, jamais à son contenu.

Ces informations viennent de l'API du type de work item :

```
GET {orgUrl}/{project}/_apis/wit/workitemtypes/{type}/fields?$expand=all&api-version=7.1
```

(`getWorkItemTypeFieldsWithReferences` dans `azure-devops-node-api`, à confirmer.)

Le résultat se met en cache par type de work item, le temps d'un import ou
d'une synchro : un import de 30 stories « Story Front » ne fait qu'une lecture.

Point d'entrée : `AzureDevOpsTicketSource` (`src/sources/azureDevOps.ts`).
Si la source est recréée à chaque import ou synchro, un cache porté par
l'instance a la bonne durée de vie : à vérifier dans `src/sources/factory.ts`
et ses appelants.

## Critères d'acceptation

- Pour un type de work item donné, la source rend, par nom de référence de champ, son libellé et son type.
- Deux work items du même type, dans un même import ou une même synchro, ne déclenchent qu'une seule lecture des champs du type.
- Un nouvel import ou une nouvelle synchro relit les champs : un champ ajouté au formulaire entre-temps est vu.
- Un échec de lecture des champs du type n'empêche pas l'import : il est écrit dans le canal de sortie DevBots, et les fonctions qui en dépendent se replient sur le nom de référence comme libellé.
- Tests unitaires avec une API simulée : cache par type, deux types différents, échec de lecture.
