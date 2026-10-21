# Benchmark — ce que fait la concurrence, et ce qu'on doit reprendre

Marché : services et plateformes de **test de résilience DDoS** (pas les protections elles-mêmes).
Sources consultées : [NimbusDDOS](https://www.nimbusddos.com/cloud-based-ddos-attack-platform.htm),
[MazeBolt](https://mazebolt.com/), ainsi que la connaissance générale des offres de test DDoS
(Red Button, DOSarrest, Haltdos, simulations Azure/AWS).

## Le tableau de marché

| Acteur                                        | Angle                   | Ce qu'il met en avant                                                                                                                                   | Ce qu'on retient                                                                 |
| --------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **NimbusDDOS**                                | Simulation cloud        | métriques **temps réel** pendant le test, **arrêt d'urgence in-band et out-of-band** en < 1 min, distribution géographique, **contrôle actif du débit** | le direct et le kill switch visible valent mieux qu'un rapport post-mortem       |
| **MazeBolt (RADAR)**                          | Test continu            | « prouvez que vos défenses marchent, en continu », notation de la protection, couverture par vecteur                                                    | une **note de couverture** lisible par un dirigeant, pas une table de tests      |
| **Red Button**                                | Simulation à la demande | rapport de test, périmètre défini avec le client                                                                                                        | le rapport est le produit                                                        |
| **Protections (Cloudflare, Akamai, Imperva)** | Mitigation              | tableau de bord d'attaque, sévérité, timeline                                                                                                           | les codes visuels d'un SOC : sévérité, timeline, « qu'est-ce qui est en danger » |
| **Azure / AWS**                               | Simulation d'attaque    | test guidé, prérequis, résultats par scénario                                                                                                           | un **assistant** qui empêche les erreurs de périmètre                            |

## Les motifs d'interface qui reviennent partout

1. **Vue d'ensemble en premier** — pas une liste de campagnes : une note, une couverture, ce qui
   demande une action. Partout, le premier écran répond à « est-ce que je suis protégé ? ».
2. **Direct pendant le test** — métriques, état d'avancement, bouton d'arrêt toujours visible.
   Nimbus en fait un argument produit ; c'est aussi une exigence de sécurité.
3. **Couverture par vecteur/niveau** — une grille ou une barre, rouge/ambre/vert, pas un tableau
   de 131 lignes.
4. **Assistant de périmètre** — le client, la cible, le niveau, l'autorisation. Les erreurs de
   périmètre sont la première cause d'incident, donc elles sont empêchées, pas documentées.
5. **Rapport client comme livrable** — PDF avec résumé exécutif, verdict, écarts, preuves. C'est
   ce qui se vend, pas l'écran d'administration.
6. **Historique et comparaison** — « est-ce mieux qu'avant ? » est la deuxième question après
   « est-ce protégé ? ».
7. **Traçabilité** — qui a autorisé, quand, avec quel périmètre. Obligatoire dans un contexte
   régulé (DORA, NIS2).

## Où notre produit est déjà au-dessus

- **Preuve scellée** avec empreintes, exigences archivées et écarts chiffrés : personne sur ce
  marché ne publie un verdict qui dit explicitement ce qu'il n'a pas atteint.
- **Mode synthétique assumé** : un instrument validé séparément d'un test réel, avec une mention
  non certifiante. C'est plus honnête que la plupart des « scores » du marché.
- **Refus de l'échelle inventée** : `max_bots` non atteint est écrit, pas maquillé.

## Où nous sommes en dessous

- Pas de **vue d'ensemble** : on atterrit sur une liste de clients.
- Pas de **direct** : pendant un test, on voit un état textuel.
- Pas de **couverture lisible** : la reachability est une table technique.
- Pas de **bibliothèque de rapports** : les rapports sont des liens JSON/HTML par campagne.
- Pas de **parcours guidé** : l'assistant existe mais l'écran ne dit pas où l'on en est.
- Pas d'**alertes** : rien ne remonte (témoin absent, calibration expirée, test en échec).

## Traduction en exigences pour la refonte

| #   | Exigence                                            | Motif marché          |
| --- | --------------------------------------------------- | --------------------- |
| E1  | Écran d'accueil « posture » avec note et couverture | MazeBolt, protections |
| E2  | Panneau direct avec kill switch permanent           | Nimbus                |
| E3  | Couverture par niveau DRS, lisible sans jargon      | MazeBolt              |
| E4  | Bibliothèque de rapports orientée client            | Red Button            |
| E5  | Assistant qui empêche les erreurs de périmètre      | Azure/AWS             |
| E6  | Comparaison avant/après mise en avant               | attentes clients      |
| E7  | Journal d'audit lisible (qui, quand, quoi)          | DORA/NIS2             |
