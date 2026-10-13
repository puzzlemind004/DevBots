# Resynchronisation

Une story peut changer dans Azure DevOps ou sur GitHub après son import : un
critère ajouté, une description précisée. La resynchronisation relit les
stories du flux chez la source et te signale celles dont le plan a été écrit
sur une version qui n'est plus la bonne. Elle ne fait que lire : rien n'est
jamais écrit chez la source.

## La lancer

Le bouton ⟳ « resynchroniser avec la source », dans le menu `…` du panneau,
ou la commande « DevBots : resynchroniser avec la source ».

Sont relues les stories de **New** et de **Ready** venues de la source du
dépôt, en une lecture par lot chez Azure DevOps, une par issue chez GitHub.
Les stories de Done et les fiches `LOCAL` ne sont pas relues. L'import, lui,
fait la même comparaison sur les tickets que tu coches.

### En arrière-plan

**Désactivée par défaut.** `devbots.sync.intervalMinutes` la lance toutes les
_n_ minutes (5 au minimum) ; `0` la laisse à la demande. En arrière-plan :

- aucune fenêtre de connexion ne s'ouvre : sans jeton enregistré ni session
  GitHub active dans VS Code, le passage est sauté et noté dans le journal ;
- une erreur (réseau, PAT expiré) va au journal, pas à l'écran ;
- seul un changement **nouveau** donne une notification, une seule fois.

## Ce qui est comparé

La révision : le numéro de révision chez Azure DevOps, la date de dernière
modification chez GitHub. Tout changement compte, y compris ce que la fiche ne
reprend pas : un commentaire est rarement là pour faire joli.

| Story | Même révision | Révision nouvelle |
| --- | --- | --- |
| Dans New | Rien | Fiche réécrite sur place |
| Dans Ready, en dev, à valider | Rien | **À revoir** |
| Dans Done (par l'import) | Rien | **À revoir**, pour mémoire |

Le bilan signale aussi les stories **introuvables** (supprimées, devenues
inaccessibles, ou dont l'issue n'est plus de confiance) et celles **fermées**
chez la source alors qu'elles ne sont pas dans Done. Il n'y touche pas : à
toi de voir s'il faut les retirer du flux.

## Une story « à revoir »

Elle porte ⚠ dans le panneau, et « à revoir » à côté de son état si elle est
déjà dans le flux de dev. Elle compte dans le badge de l'icône DevBots.

Le bouton « voir les changements » (sur la story, ou depuis la notification)
ouvre la vue diff : à gauche la version sur laquelle le plan a été écrit, à
droite la source aujourd'hui. Quand la fiche est identique, le changement est
ailleurs dans le ticket (un commentaire, un champ non repris) : la fenêtre le
dit, et « Ouvrir dans la source » mène au ticket sans lever la marque. Puis
tu tranches :

| Choix | Effet |
| --- | --- |
| **Garder le plan** | Le changement ne remet rien en cause. La fiche ne bouge pas ; la version reçue devient la référence, la marque disparaît |
| **Replanifier** | La story revient dans New, réécrite d'après la source, et l'atelier rouvre sur elle |

« Replanifier » n'est proposé qu'à une story de Ready qui n'est pas partie en
dev. Pour une story en file, bloquée ou à valider, retire-la d'abord du flux
(elle revient dans Ready) ; pour une story en cours, arrête son agent.

### Replanifier

L'atelier rouvre en compréhension, dans une session Claude neuve qui lit la
fiche réécrite. Les versions du plan restent consultables, la dernière reste
affichée ; toutes ses sections sont à relire avant de repasser en Ready. Le
changement est noté dans `history.jsonl`.

### Lancer ou merger une story à revoir

Possible, après confirmation : le lancement du dev propose d'abord de voir les
changements, le feu vert rappelle que la story a bougé.

## `.work/sources/`

| Fichier | Contenu |
| --- | --- |
| `<id>.md` | La fiche telle que la source la donnait à la dernière version acceptée |
| `<id>.incoming.md` | La version reçue, en attente de ta décision |

Ces fichiers sont régénérés par l'import et la resynchronisation : ne les
modifie pas à la main.
