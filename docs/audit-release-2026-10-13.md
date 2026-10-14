# Déploiement des corrections d’audit — 13 octobre 2026

La build **451** de Ddostester est déployée sur VPS1. Elle correspond au snapshot local `d98db08+audit.c5392dde4e66` ; ce suffixe identifie les sources validées, et ne constitue pas un nouveau commit Git. Les modifications locales ont été préservées, sans commit ni push.

## Release et sauvegardes

- Release : `/home/shieldtest/ddostester-releases/audit-c5392dde4e66`.
- Activation systemd : `/etc/systemd/system/ddostester.service.d/40-verified-release.conf`.
- Sauvegarde protégée : `/root/ddostester-release-backups/audit-c5392dde4e66` (base PostgreSQL, environnement, définition du service, état des comptes et résultat de promotion).
- Archive SHA-256 : `7d71a3a5827370aa11984b334314f1df5c73d134701a30c2ebeca0746dd32c50`.
- La précédente release 450 et son drop-in `30-access` restent disponibles. Le checkout historique sur le VPS est conservé.

Aucune migration supplémentaire, rotation JWT ou modification d’environnement n’a été effectuée. Les **11 comptes**, profils, états, mots de passe et versions de session ont été comparés avant et après promotion : ils sont conservés. `abdelha@wedos` reste le seul administrateur. Le mode single et le scheduler désactivé sont conservés.

## Validation

La vérification locale complète a passé le lint, les types, les builds et **1 338 tests** (947 backend, 391 frontend). Treize tests conditionnels étaient ignorés par cette exécution ; les contrôles PostgreSQL décrits ci-dessous ont ensuite été exécutés sur le VPS.

- Rollback réel PostgreSQL : mutation de compte, campagne synthétique non exécutée et entrée d’audit dans une transaction intentionnellement annulée ; aucune de ces mutations n’a persisté.
- Verrou de runtime : exclusion d’un deuxième processus, puis acquisition possible après libération du premier ; exclusion également vérifiée avec le service actif.
- Vérification de la build API et de chaque asset UI via le manifeste de release.
- Permissions administrateur et viewer, lecture par cookie HttpOnly/SameSite Strict, refus des JWT de session dans l’URL et refus des écritures par simple cookie.
- Navigateur sur les fichiers effectivement servis : administration des utilisateurs et sessions visible, rapports HTML et CSV accessibles sans JWT dans l’URL, aucune erreur JavaScript détectée.
- Chaîne d’audit vérifiée valide. Audit des dépendances de production : zéro vulnérabilité signalée au moment du déploiement.

**Aucune campagne ni génération de trafic n’a été lancée.**

## Monitoring

Les dashboards provisionnés `shieldtest-run` et `shieldtest-resilience` sur VPS2 sont adaptés aux séries `successful_rps` et `failed_ratio`, avec des libellés décrivant les résultats du générateur. Les personnalisations des modèles Grafana actuels sont conservées. La vérification utilise le stockage unifié `resource`, et non l’ancienne table `dashboard`.

La sauvegarde des fichiers et modèles antérieurs est conservée dans `/root/ddostester-release-backups/audit-c5392dde4e66-monitoring`. Le rechargement est assuré par le provisioning Grafana ; aucun redémarrage du monitoring n’est nécessaire. Les corrections de libellés sont également appliquées aux JSON du dépôt, sans modifier la release applicative immuable.

L’URL Grafana configurée en loopback suppose le tunnel utilisateur habituel vers VPS2. Prometheus est accessible depuis VPS1 par le forwarding existant. Aucun agent de sonde distant n’est configuré actuellement.

## Retour arrière et limites

Pour revenir à la release 450 : arrêter Ddostester, restaurer un éventuel ancien drop-in `40-verified-release.conf` ou retirer uniquement celui ajouté par cette promotion, puis effectuer `systemctl daemon-reload` et redémarrer. Vérifier ensuite la santé, la build API/UI et les accès. Ne pas restaurer automatiquement le dump PostgreSQL pour un simple retour arrière de code : cela supprimerait les mutations légitimes intervenues depuis la promotion.

Les sauvegardes Grafana permettent de restaurer les fichiers provisionnés précédents. Les modèles runtime sont également sauvegardés pour examiner les personnalisations si une restauration est nécessaire.

Le témoin d’audit externe, l’orchestration Kubernetes distribuée et les adresses publiques des agents restent des travaux d’infrastructure ultérieurs. Aucun cluster ni service externe supplémentaire n’a été déployé lors de cette opération.
