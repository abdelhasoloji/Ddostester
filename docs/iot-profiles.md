# Profils IoT HTTP simulés

Le profil `sensor-heartbeat/v1` est disponible dans le contrat de création des campagnes via `iotProfile`. Il développe un GET de santé vers `probeUrl`, une pause de 500–1 500 ms, un POST JSON de télémétrie vers `target`, puis une pause de 1 000–2 000 ms. Les pauses interviennent entre requêtes terminées. Le profil exige `agent: builtin`, `vector: http-post` et une origine identique pour santé et télémétrie. Les deux URLs restent soumises à l'allowlist normale.

Une graine entière publique entre 0 et 4 294 967 295 et un index entre 0 et 999 déterminent l'identité, le petit payload (moins de 256 octets) et les pauses. Le contrat utilise SHA-256 sur la version, la graine et l'index ; il ne dépend ni d'une horloge ni d'un état aléatoire. Le même index et la même graine reproduisent le même appareil synthétique. Le payload répète volontairement `sequence: 0` : il s'agit d'un échantillon statique reproductible, pas d'un flux temporel de capteur.

Exemple de **brouillon**, à adapter uniquement à une cible dédiée autorisée supportant ce POST :

```json
{
  "name": "Synthetic sensor lab",
  "createdBy": "operator@example.test",
  "target": "http://lab-target:8080/api/echo.php",
  "probeUrl": "http://lab-target:8080/health",
  "vector": "http-post",
  "agent": "builtin",
  "iotProfile": {
    "id": "sensor-heartbeat/v1",
    "seed": 42,
    "deviceIndex": 0
  },
  "maxRps": 2,
  "concurrency": 1,
  "maxDurationSec": 10,
  "authorized": false
}
```

L'opérateur doit attester l'autorisation avant création ; l'exemple avec `authorized: false` sera refusé. L'API authentifiée impose l'auteur à partir du compte connecté. La création compile et conserve le flow avant approbation, sans lancer la campagne. Confirmation, séparation des décisions en mode team, caps actuelles, vérifications de cible et arrêt restent ceux du produit. Les budgets ne sont pas recalculés par le profil. La revalidation à l'approbation/lancement accepte uniquement le flow identique à son développement déterministe ; modifier sa graine sans régénérer son flow est refusé.

Un flow personnalisé, un endpoint mix, un dataset, un body global ou le cache-busting ne peuvent pas être combinés avec ce profil. Le moteur fleet MVP refuse encore les flows ; ce profil ne prouve donc pas l'orchestration d'une flotte de capteurs. Aucun changement d'IP, émulation de firmware, réseau géographique, session de device persistante ou débit réellement identique entre runs n'est promis. Identité, payload et think-time sont reproductibles ; scheduling, latences et résultats dépendent de l'environnement.

Le formulaire propose « Synthetic device journey », puis la graine et l'index. Choisir Sensor heartbeat v1 sélectionne explicitement builtin/POST sans changer les budgets. Les champs existants restent conservés ; un conflit avec body, flow, endpoint mix, dataset ou cache-busting bloque la soumission avec une indication de correction. Une graine ou un index invalide, une origine différente ou un changement vers un moteur incompatible bloque aussi le brouillon. L'attestation reste obligatoire.

Le profil et ses paramètres restent dans la campagne conservée et apparaissent dans les détails. Au démarrage du run, le runner copie profil et flow dans la configuration du résultat. Le rapport HTML et les colonnes CSV `iotProfile`, `iotSeed`, `iotDeviceIndex` lisent ce snapshot ; ils ne déduisent pas le profil historique d'une campagne modifiée ensuite. Un historique sans paramètres enregistrés garde ces colonnes vides. Les comparaisons de runs homogènes restent à compléter.

La recette locale vérifie création/lecture réelles, maintien en attente, absence de run automatique, refus des entrées invalides et exécution GET/POST sur une cible loopback dédiée. Elle ne valide pas encore ce profil sur le cluster source-06 ni avec les moteurs externes.
