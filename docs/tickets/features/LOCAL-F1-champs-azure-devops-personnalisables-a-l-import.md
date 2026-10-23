---
source: "local"
source_id: "LOCAL-F1"
level: "feature"
created_at: "2026-10-23T14:00:00.000Z"
title: "Champs Azure DevOps personnalisables à l'import"
---

# Champs Azure DevOps personnalisables à l'import

## Description

À l'import d'un work item Azure DevOps, DevBots ne lit que `System.Description`
et `Microsoft.VSTS.Common.AcceptanceCriteria`, en dur dans `toTicket`
(`src/sources/azureDevOps.ts`). Tous les autres champs sont perdus sans
avertissement. Or les processus Azure personnalisés ont souvent leurs propres
champs. Chez RayonVert, le type « Story Front » range le persona dans
« Pour qui ? » et les critères (CA1, CA2… en Étant donné / lorsque / alors) dans
« Que faire ? », deux champs `Custom.*`. La planification ne reçoit donc pas
les critères : elle les invente à partir de l'objectif.

Exemple de référence : le work item 48012 « Afficher les CNILs ».

La feature ajoute :

- `devbots.azureDevOps.fields`, par niveau (`story`, `feature`, `epic`) : des
  champs en plus, comme sections supplémentaires, ou à la place des champs
  lus par défaut pour la description et les critères (`role`) ;
- un repli qui ne perd plus rien en silence : les champs HTML non lus vont
  sous « Autres champs » (`devbots.azureDevOps.includeUnmappedRichTextFields`,
  `devbots.azureDevOps.excludedFields`) ;
- une commande pour lister les champs d'un work item et trouver les noms `Custom.*`.

Demande complète : `evol/devbots-evolution-champs-azure.md` (hors git).

## Critères d'acceptation

1. Sans réglage, un import produit le même fichier qu'en 0.5.0, à l'éventuelle section « Autres champs » près.
2. Les champs sans rôle apparaissent comme sections supplémentaires, dans l'ordre configuré, avec le titre configuré ou, à défaut, le libellé Azure.
3. Avec un rôle `acceptanceCriteria` (ou `description`), la section vient de ce champ, le champ par défaut n'est plus lu, et le texte de repli n'apparaît que si ce champ est vide.
4. La configuration `story` ne touche pas les features, et inversement.
5. Avec le repli actif, un champ HTML ni lu ni exclu apparaît sous « Autres champs » ; avec le repli désactivé, il n'apparaît pas.
6. `System.History` n'apparaît jamais par défaut.
7. Un nom de champ inconnu donne un avertissement unique et n'empêche pas l'import.
8. Modifier « Que faire ? » dans Azure est signalé comme un changement de la story à la resynchronisation.
9. Le connecteur GitHub n'est pas touché.
