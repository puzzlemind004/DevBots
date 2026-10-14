# Review et merge

Une story « À valider » se relit depuis sa carte du panneau, sans quitter
VS Code : un clic pour le diff, un pour le worktree, un pour le feu vert ou
pour renvoyer des retours. Le merge reste local, sans pull request : chaque
story est mergée dans la branche de sa feature. La pull request de la feature
vers `main` reste hors de l'extension.

## La carte « À valider »

| Bouton | Effet |
| --- | --- |
| ✓ Feu vert | Merge de la story, après confirmation (voir plus bas) |
| 💬 Discuter | La conversation de l'agent, reprise dans Claude Code (voir [Dev et supervision](dev-et-supervision.md)) |
| Diff | Vue diff native, fichier par fichier |
| 📂 Worktree | Dans une nouvelle fenêtre, ou ajouté à l'espace de travail |

Le clic droit donne aussi « Écrire à l'agent » (tes retours), le CR, le rapport de supervision, le journal et
« Lancer l'application ».

### Le diff

La branche de la story contre celle de sa feature, depuis leur point de départ
commun, dans l'éditeur multi-fichiers de VS Code. Le côté droit est le fichier
du worktree lui-même : tu peux y retoucher le code pendant ta revue. Tes
retouches partent avec la story, au feu vert comme avec tes retours.

Une story de Done garde son diff : ce que son merge a apporté à la feature.

### Lancer l'application

`devbots.review.serveCommand` (par défaut `npx ng serve --port {port}`) tourne
dans un terminal ouvert sur le worktree. Chaque worktree reçoit son port, à
partir de `devbots.review.basePort` (4201, 4202…), et le garde : le 4200 reste
au dépôt principal. Les agents, eux, ne lancent jamais de serveur.

### Ouvrir le worktree

Dans une nouvelle fenêtre, ou ajouté à l'espace de travail courant. Attention :
une fenêtre à un seul dossier devient alors un espace de travail multi-racine,
et VS Code recharge les extensions. Le feu vert retire le worktree de l'espace
de travail avant de le supprimer.

## Tes retours

Un champ texte : tes remarques repartent à l'agent, dans **sa** session
(`--resume`), comme prioritaires. La story repasse en dev, puis par la revue du
CR et la supervision, dans des sessions neuves, et revient « À valider ». Le
compteur de boucles repart de zéro.

Le tri ne recrée pas une fiche que la story a déjà fait naître : une fiche
du même titre, née de la même story, suffit.

## Le feu vert

Les merges passent un par un ; une story approuvée pendant un merge attend son
tour. Pour chacune :

1. **Tes retouches.** Ce qui n'est pas commité dans le worktree l'est, en
   « retouches de revue ».
2. **Intégration.** Si la branche de la feature a avancé depuis le départ de
   la story, elle est intégrée : par un rebase si l'historique de la story est
   linéaire, par un merge s'il contient déjà un merge (un rebase rejouerait des
   conflits déjà résolus).
3. **Checks.** Après une intégration seulement, les commandes de
   `devbots.merge.checkCommands` tournent dans le worktree (par exemple
   `npx ng build` et `npx ng test --watch=false`). Sans intégration, le code
   est celui que l'agent a validé. Vide par défaut.
4. **Merge.** La branche de la feature avance jusqu'à la story, en
   fast-forward. Extraite dans le dépôt ou dans un autre worktree, elle avance
   par un `git merge --ff-only` dans ce dossier, qui refuse d'écraser tes
   modifications en cours ; sinon, la référence est déplacée.
5. **Nettoyage.** Le worktree et la branche de story sont supprimés. Un
   fichier verrouillé (fréquent sous Windows) n'empêche pas le merge : la
   notification dit ce qui reste à supprimer à la main.
6. **Done.** La fiche passe dans `done/`, avec `merged_at`, `merge_commit` et
   `merged_into` dans son frontmatter. `state.json` garde son parcours :
   CR, rapport, journal et diff restent consultables. Ses fichiers sont
   libérés, et les stories qui l'attendaient partent.

### Quand le merge bute

| Cas | Effet |
| --- | --- |
| Conflit à l'intégration | Le rebase est annulé, un merge est laissé en cours avec ses conflits. L'agent les résout dans sa session ; l'extension conclut le merge en commitant, mais refuse tant qu'un fichier garde ses marqueurs. Puis revue, supervision, « À valider » |
| Check en échec | La fin de sa sortie repart à l'agent, dans sa session. Puis revue, supervision, « À valider » |
| Merge refusé (feature extraite avec des modifications qui gênent, feature qui a bougé entre-temps) | La story reste « À valider », avec la raison. Redonne ton feu vert une fois la voie libre |
| VS Code fermé pendant un merge | Au redémarrage, la story revient « À valider » ; le feu vert suivant annule le rebase laissé en plan et reprend |

L'agent ne lance jamais `git merge`, `git rebase` ni `git commit` : ces
commandes restent refusées. C'est l'extension qui intègre, commite et merge.
