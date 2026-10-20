# Rondivou

Application privée de gestion d'un salon, interface française et fuseau `Africa/Algiers`. Node.js **24+**, Express et SQLite natif. Aucun service de base de données externe requis.

## Démarrer

```sh
cd /workspace/rondivou
npm ci
cp .env.example .env
npm start
```

Le serveur écoute sur le port 3000 et sur `127.0.0.1` par défaut. En local, si `ADMIN_PASSWORD` est vide, un mot de passe aléatoire est conservé dans `.data/admin-password` (fichier privé, exclu de Git). Consultez ce fichier localement pour vous connecter. Ne le publiez pas. Pour un hébergement accessible au téléphone, configurez un mot de passe fort, `HOST=0.0.0.0`, `PUBLIC_URL=https://votre-domaine`, `COOKIE_SECURE=true` et un reverse proxy HTTPS. Le processus doit rester actif pour traiter les rappels et les messages sortants.

```sh
npm test
```

Les tests utilisent une base éphémère et des services distants simulés ; ils n'envoient pas de vrais messages. `/health` fournit une vérification HTTP sans données clientes. Le calendrier, les rendez-vous, les conversations et les réglages nécessitent une connexion administrateur.

## Réservation

- Une seule professionnelle, interdiction des chevauchements, horaires flexibles tous les jours.
- Coiffure et maquillage : 1 h. Coloration et lissage : 3 h. Balayage : 8 h.
- Nom réel et téléphone facultatifs. Date, heure et prestation obligatoires.
- Les deux côtés des conversations **textuelles** sont conservés et transmis à un compte Telegram privé. Images et voix ignorées.
- Extraction déterministe prudente des prestations en français/arabe, dates ISO ou `jj/mm/aaaa`, `demain`/`غدوة`, et heures numériques. Ce n'est pas un modèle linguistique : langage libre complexe, translittération, heures écrites en lettres et ambiguïtés exigent une saisie manuelle. L'accord explicite (`je confirme`, `موعدك مؤكد`...) est nécessaire pour le traitement automatique. Un simple « oui » n'est volontairement pas interprété comme une confirmation de réservation.
- Les messages avec plusieurs dates/prestations, demandes de déplacement/annulation, ou informations manquantes restent à vérifier. Les demandes d'annulation ne suppriment jamais un rendez-vous automatiquement.
- Telegram affiche `rondivou` et `rondivou confirmé`. Le premier ouvre un formulaire dans le navigateur du téléphone (connexion requise). Le second valide les données complètes sans ambiguïté ; sinon il propose le formulaire. Le formulaire offre date, heure et prestation, plus nom, téléphone et notes facultatifs. Aucun secret de session n'est inclus dans le lien.
- Les imports historiques sont **toujours** soumis à une vérification manuelle. Les identifiants Meta dédupliquent les messages. Un message source ne peut créer qu'un seul rendez-vous.
- Les rappels sont mis en file à l'échéance des 24 h (avec un délai dépendant de la disponibilité du serveur et des envois). Les rendez-vous créés moins de 24 h avant le début n'en reçoivent pas. Une réservation sans conversation liée ne peut pas recevoir de rappel cliente. Après envoi réussi à la cliente, le statut devient `En attente de confirmation`. Une réponse explicitement confirmative peut confirmer la présence. Plusieurs rendez-vous à confirmer pour la même cliente demandent une vérification humaine ; utilisez la liste pour vérifier lequel est visé. Aucune annulation automatique.
- Les erreurs d'envoi sont visibles dans les notifications et Connexions ; la file persistante réessaie avec délai progressif. La livraison à une API externe ne peut pas être garantie exactement une fois en cas d'arrêt entre acceptation distante et écriture locale.

## Telegram (un seul compte)

1. Créez un bot avec **BotFather** et configurez `TELEGRAM_BOT_TOKEN` côté serveur.
2. Depuis le compte autorisé, démarrez le bot. Obtenez votre identifiant numérique via un outil Telegram de confiance ou l'API officielle `getUpdates` avant d'activer le webhook. Définissez `TELEGRAM_ADMIN_ID` avec cet identifiant utilisateur (identique à l'identifiant du chat privé).
3. Générez un secret aléatoire pour `TELEGRAM_WEBHOOK_SECRET` (caractères alphanumériques, `_` et `-`), configurez `PUBLIC_URL` en HTTPS et redémarrez.
4. Dans **Connexions**, utilisez **Connecter et tester Telegram**. Cela enregistre `/webhooks/telegram` avec le secret et envoie un test.

Les mises à jour d'autres comptes et les groupes sont ignorés. Les boutons de formulaire exigent une URL publique HTTPS accessible au téléphone. L'administration possède son propre mot de passe ; le compte Telegram seul ne donne pas accès au site. Destination réseau : `api.telegram.org`.

## Meta : Facebook Messenger et Instagram

Le code contient les adaptateurs webhook et Graph API. **La réception réelle, l'historique disponible et les rappels doivent être validés avec votre application Meta et vos permissions.** Aucune connexion Meta réelle n'est incluse ou prétendue testée.

1. Créez/configurez une application Meta adaptée à une Page Facebook et un compte Instagram professionnel lié. Sélectionnez le parcours **Instagram avec connexion Facebook** pour l'adaptateur actuel ; la connexion Instagram directe utilise d'autres endpoints et n'est pas implémentée ici.
2. Configurez `META_APP_SECRET`, un `META_VERIFY_TOKEN` aléatoire, `META_PAGE_ACCESS_TOKEN`, `META_PAGE_ID`, `META_INSTAGRAM_ID` et la version Graph API prise en charge. Le code utilise `v23.0` par défaut, modifiable avec `META_GRAPH_VERSION`.
3. Configurez les webhooks HTTPS sur `/webhooks/meta` et le jeton de vérification. Activez les événements de messages entrants et les échos sortants pour pouvoir suivre les réponses du manager depuis les applications mobiles. Configurez les abonnements Page et Instagram dans Meta ; le bouton du site abonne la Page aux champs Messenger.
4. Les permissions dépendent du produit/parcours choisi ; notamment `pages_messaging`, les accès de gestion/lecture Page et les permissions de messagerie Instagram correspondantes. Vérifiez les exigences actuelles dans la documentation Meta. App Review, accès avancé ou vérification d'entreprise peuvent être nécessaires pour les clientes qui n'ont pas un rôle dans l'application. Testez avec les comptes autorisés avant la mise en production.
5. Testez dans chaque sens depuis Messenger et Instagram : texte entrant, réponse du manager, transfert Telegram, accord explicite, réservation et conflit. Vérifiez la signature `X-Hub-Signature-256` ; le serveur refuse les signatures invalides.
6. Utilisez **Importer le dernier mois** pour parcourir les conversations et messages autorisés. Les contenus déjà récupérés sont ignorés. Les messages sont envoyés à Telegram à mesure du traitement ; un gros historique prend du temps. Si un canal refuse l'accès, l'import signale l'échec et conserve la progression. Relancer est sans doublons de messages.

Les rappels utilisent la Send API du canal d'origine et **ne contournent pas les fenêtres de messagerie Meta**. Un rappel 24 h avant un rendez-vous peut arriver longtemps après le dernier message de la cliente et être refusé. Un mécanisme de notification autorisé par Meta peut être nécessaire avant de rendre cette fonctionnalité utilisable en production. N'utilisez pas de tags ou de permissions non autorisés pour contourner cette limite. Le refus reste visible, le rendez-vous est conservé, et son statut ne prétend pas qu'un rappel a été livré. Destination réseau : `graph.facebook.com`.

## Données et exploitation

SQLite et la file de livraison sont conservés dans `.data/rondivou.sqlite`. Sauvegardez cette base avec l'API de sauvegarde SQLite ou après arrêt du serveur (une simple copie du fichier actif sans son WAL n'est pas une sauvegarde fiable). Les messages clients sont des données privées : limitez l'accès à l'hébergement et au compte Telegram et définissez une politique de conservation adaptée avant utilisation réelle. Ne publiez jamais `.env`, `.data`, les tokens ou les conversations.

Cette première version fournit une interface mobile, des connecteurs configurables et un traitement de réservation testé localement. Elle ne comprend pas WhatsApp, la transcription vocale, ni une page de réservation publique. Le paramétrage du nom du salon, les durées et les services sont actuellement dans le code (`src/domain.js`) ; toute évolution doit conserver l'absence de chevauchements.
