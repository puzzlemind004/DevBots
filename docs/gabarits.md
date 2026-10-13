# Gabarits

DevBots livre un gabarit par défaut pour le plan de story et pour le compte
rendu de dev (CR). Un dépôt les remplace par les siens sans toucher à
l'extension.

## Où les mettre

| Gabarit | Fichier du dépôt | Rempli par |
| --- | --- | --- |
| Plan de story | `.work/templates/plan.md` | L'extension, au passage en ready |
| CR | `.work/templates/cr.md` | L'agent de dev |

Pour chacun, l'extension retient le premier qui existe :

1. un paramètre explicite (aujourd'hui `devbots.planning.template`, pour le
   plan) ;
2. le fichier de `templates/` dans le dossier du flux ;
3. le gabarit par défaut.

Un paramètre qui désigne un fichier absent est une erreur : l'extension ne
retombe pas en silence sur le défaut quand le dépôt a demandé autre chose.

« DevBots : personnaliser les gabarits » dépose les gabarits par défaut dans
`.work/templates/` et les ouvre. Un fichier déjà présent n'est jamais écrasé.

## Plan

Le plan est rempli par le code, depuis les marqueurs `{{…}}` listés dans
[Planification](planification.md#gabarit). Le frontmatter de la fiche de
`ready/` reste tenu par l'extension : le gabarit ne décide que du corps.

## CR

Le CR est rédigé par l'agent de dev. L'extension remplit `{{title}}` et
`{{source_id}}`, dépose le résultat dans `.devbots/cr-template.md` du worktree
et donne ce chemin à l'agent : les sections sont des consignes, et les
commentaires `<!-- … -->` disent ce que chacune attend. L'agent écrit son CR
dans `.devbots/cr.md` ; l'extension le copie dans `.work/runs/<id>/cr.md`.

Rien de ce que l'extension affiche ne dépend de la forme du CR : le statut du
build et des tests vient de la sortie structurée de la session de dev. Le CR
peut donc prendre la forme que veut l'équipe. Seule son absence est contrôlée :
un CR manquant renvoie l'agent à sa rédaction.
