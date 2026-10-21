# Déploiement

L'image Docker incluse fonctionne sur une plateforme prenant en charge Node.js 24 et les conteneurs. Elle exécute les tests pendant la construction et expose le port `8080` (remplaçable via `PORT`).

```sh
docker build -t rondivou .
```

## Paramètres nécessaires

Configurez ces paramètres dans l'espace de configuration sécurisé de l'hébergeur :

- `ADMIN_PASSWORD` : un mot de passe privé d'au moins 16 caractères. Ne le placez jamais dans Git ni dans une commande partagée.
- `PUBLIC_URL` : l'URL publique HTTPS du service.
- `COOKIE_SECURE=true` (déjà défini par l'image).
- `DATABASE_PATH=/data/rondivou.sqlite` (déjà défini par l'image).
- Montez un **stockage persistant** dans `/data` et utilisez **une seule instance** du service. Cette version utilise SQLite local et une professionnelle unique. Plusieurs réplicas possédant des disques distincts créeraient des calendriers différents.
- Configurez les variables Meta et Telegram décrites dans `.env.example` et `README.md` pour activer les connecteurs.

La route de santé est `/health`. Le service doit rester actif pour recevoir les webhooks et traiter la file d'envoi et les rappels. Si l'offre gratuite se met en veille, les rappels peuvent être retardés ; une veille ne supprime pas les rendez-vous si le disque est réellement persistant.

## Choix d'une offre gratuite

Un compte chez l'hébergeur et son authentification sont nécessaires pour publier sous votre contrôle. La gratuité d'un site statique (Google Sites, GitHub Pages, etc.) ne suffit pas à exécuter ce serveur et sa base de données.

Ne déployez pas cette version pour de vrais rendez-vous sur un disque éphémère : les données disparaîtraient lors des redémarrages ou redéploiements. Certaines offres gratuites de conteneurs n'incluent aucun disque persistant. Sur ces plateformes, il faut choisir une offre avec disque ou adapter le stockage à un service de base de données externe. Google Cloud Run ne fournit pas de disque SQLite persistant local ; l'image peut y démarrer, mais le stockage doit être adapté avant utilisation réelle.

Aucun abonnement payant ne doit être activé automatiquement. Vérifiez les conditions de l'offre et les éventuelles exigences de carte bancaire avant de publier.

## Contrôles après publication

1. `/health` répond `200`.
2. Connexion administrateur depuis un téléphone en HTTPS.
3. Création d'un rendez-vous, refus d'un chevauchement, puis vérification après redémarrage que le rendez-vous est toujours présent.
4. Configuration des URLs de webhooks Meta et Telegram sur le nouveau domaine.
5. Test réel de chaque canal et des erreurs de livraison (les tests locaux simulent les services externes).

La présence de ces fichiers ne signifie pas qu'un déploiement a déjà été effectué.

## AWS Lightsail avec crédits AWS

Le script `deploy/aws-cloudshell.sh` s'exécute **dans votre propre AWS CloudShell**. Il vérifie l'accès AWS, interroge le tarif actuel du bundle `micro_3_0` dans `eu-west-3` (1 Go minimum, prix de base plafonné à 10 USD/mois), puis attend que vous saisissiez `DEPLOY` avant de créer une ressource. Vérifiez dans **Billing > Credits** que vos crédits couvrent Lightsail et ne sont pas expirés. Les crédits n'empêchent pas automatiquement une facturation après épuisement.

1. Téléversez l'archive source dans CloudShell, puis décompressez-la.
2. Dans le dossier du projet, exécutez `bash deploy/aws-cloudshell.sh`.
3. Vérifiez le prix affiché et autorisez la création uniquement si l'offre vous convient.
4. Le script crée un serveur Ubuntu, une IP statique attachée et un bucket S3 privé temporaire pour transférer uniquement le code. Il installe Docker, l'application et Caddy. Seuls HTTP, HTTPS et le SSH via Lightsail Connect sont ouverts.
5. Le résultat est une adresse HTTPS basée sur l'IP et `sslip.io`, sans achat de domaine. La disponibilité de ce service DNS gratuit et l'émission du certificat dépendent de leurs fournisseurs ; vous pouvez ensuite remplacer cette adresse par un domaine personnel.
6. Le mot de passe administrateur est généré **sur le serveur**. Retrouvez-le dans une session SSH privée depuis la console Lightsail : `sudo cat /opt/rondivou/admin-password`. Ne le collez pas dans une conversation ou dans Git.
7. Le serveur conserve sa base dans `/var/lib/rondivou/database`. Cette base survit au redémarrage du serveur et au remplacement des conteneurs. Elle ne survit pas à la suppression du serveur sans sauvegarde. Les connecteurs se configurent dans `/opt/rondivou/runtime.env` ; recréez le conteneur après modification de ses variables. `docker restart` ne recharge pas un fichier env.

Le script affiche l'URL seulement après une vérification HTTPS de `/health`. Le bucket temporaire est supprimé après succès. Si le déploiement échoue, `.deployment-state.env` dans CloudShell contient les noms des ressources créées pour permettre l'inspection et le nettoyage ; ne relancez pas le script sans vérifier les ressources existantes. Chaque exécution approuvée crée un nouveau serveur.

Pour arrêter définitivement les coûts, sauvegardez les données nécessaires, supprimez l'instance dans Lightsail, puis libérez son IP statique et supprimez les éventuels buckets temporaires et snapshots restants. Arrêter une instance seule ne supprime pas nécessairement sa facturation. Aucun déploiement AWS réel n'a été validé depuis cet environnement sans authentification AWS ; la syntaxe des scripts et la construction locale de l'image sont contrôlées séparément.

## EC2 à Stockholm : parcours retenu après le test d'accès

Le compte a réussi un `RunInstances --dry-run` dans **eu-north-1** avec l'AMI Amazon Linux 2023 `ami-0a7acf71650e53201` et `t3.micro`. Cela ne garantit pas les autorisations de toutes les autres opérations. Le script EC2 utilise cette région ; il n'utilise ni Lightsail ni SSM.

Depuis le checkout dans AWS CloudShell :

```sh
git pull --ff-only origin codex/rondivou
bash deploy/aws-ec2-cloudshell.sh
```

Le script vérifie les lectures VPC/sous-réseau/AMI, l'accès au code public et les plages IP officielles EC2 Instance Connect. Il teste ensuite en `--dry-run` les principaux paramètres de lancement (disque chiffré, mode CPU standard, métadonnées et tags). Aucune ressource de déploiement n'est créée avant ces contrôles et la saisie de `DEPLOY`. Un refus de politique est signalé ; le script ne change pas de région pour le contourner.

Ressources prévues : une instance `t3.micro`, son disque racine chiffré `gp3` de **16 Gio**, un groupe de sécurité et **une Elastic IP** pour conserver l'adresse HTTPS lors des arrêts/redémarrages. EC2, EBS et IPv4 sont facturables séparément. Vérifiez les prix régionaux actuels et la couverture des crédits dans AWS Billing avant d'accepter. Le script n'installe pas d'alarme de budget ni de plafond de facturation. Il utilise `CpuCredits=standard` pour éviter les crédits CPU Unlimited payants.

Seuls HTTP et HTTPS sont publics. Le port SSH n'est ouvert qu'aux plages AWS EC2 Instance Connect de la région, obtenues depuis `https://ip-ranges.amazonaws.com/ip-ranges.json`. Pour lire le mot de passe après déploiement : **EC2 > Instances > instance Rondivou > Connect > EC2 Instance Connect**, utilisateur `ec2-user`, puis `sudo cat /opt/rondivou/admin-password` dans cette session privée. La permission `ec2-instance-connect:SendSSHPublicKey` est requise pour cette connexion ; si elle est refusée, demandez son activation à l'administrateur. Aucun mot de passe ni aucune clé d'accès AWS ne doit être transmis au chat.

Le bootstrap vérifie le SHA-256 de l'archive source, installe et teste les dépendances avec l'image officielle Node 24, puis lance l'application et Caddy. Le site garde sa base dans `/var/lib/rondivou/database` sur le disque EBS. Les processus Docker redémarrent automatiquement. L'adresse utilise `sslip.io` et HTTPS automatique ; la disponibilité du DNS et l'émission du certificat restent à vérifier lors du vrai déploiement. Les connecteurs Meta et Telegram restent à configurer.

Les identifiants créés sont enregistrés au fur et à mesure dans `.deployment-ec2-state.env` (ignoré par Git). Après une interruption, inspectez ce fichier et les ressources avant toute nouvelle tentative. Le script bloque une seconde exécution si ce fichier existe, afin d'éviter un serveur supplémentaire. Il ne supprime pas automatiquement les ressources déjà créées et potentiellement utiles. Si l'instance n'a pas pu être créée, une Elastic IP allouée peut quand même continuer à être facturée jusqu'à sa libération.

Pour nettoyer définitivement : sauvegardez les données, terminez l'instance concernée (son disque racine est supprimé à la terminaison), libérez l'Elastic IP et supprimez le groupe de sécurité lorsqu'il n'est plus utilisé. Un simple arrêt ne supprime ni le disque ni l'IP facturables. La réussite du test d'autorisation ne constitue pas un déploiement ; l'URL n'est affichée comme opérationnelle qu'après la vérification HTTPS de `/health`.

## Réinstaller sur un EC2 existant après la suppression du premier serveur

`deploy/install-existing-ec2.sh` s'exécute **dans le terminal SSH du serveur à conserver**, avec `sudo`, l'ID attendu du serveur et un SHA Git complet. Il contrôle l'identité via IMDSv2, Amazon Linux 2023 x86_64, les ports, l'espace disque, et l'absence de tout ancien répertoire de l'application. Il s'arrête sans écraser les fichiers en cas de conflit. Il télécharge le code à la révision fournie en HTTPS, puis utilise le bootstrap Node 24 testé. Il ne crée aucune instance EC2, aucun disque ni aucune Elastic IP et ne demande pas de clés AWS.

Le contrôle de santé final est local : ouvrez ensuite HTTP 80 et HTTPS 443 dans le groupe de sécurité existant et vérifiez l'adresse HTTPS de l'extérieur. La connexion SSH doit rester restreinte. Le mot de passe est conservé sur le serveur dans `/opt/rondivou/admin-password`, lisible avec `sudo` ; ne le transmettez pas au chat. Cette variante utilise l'IPv4 publique courante. Si elle change après un arrêt/démarrage, il faut mettre à jour `PUBLIC_URL` dans `runtime.env`, l'hôte du Caddyfile et recréer les conteneurs avec leur configuration actualisée. Un simple redémarrage des conteneurs ne recharge pas les variables du fichier env.

Après exposition d'un mot de passe, `sudo python3 deploy/reset-admin-password.py` permet de le remplacer pour le profil EC2 standard. Exécutez une copie de ce fichier issue d'une révision Git vérifiée dans le terminal SSH du serveur. Le script vérifie les montages existants, arrête brièvement l'application, remplace uniquement le mot de passe dans les fichiers privés, révoque les anciennes sessions et recrée le conteneur avec la même image et la même base. Les autres variables sont conservées. Il vérifie le nouveau login sans afficher le mot de passe. Une interruption nécessite une inspection ; ne redémarrez pas l'ancien conteneur contenant le mot de passe exposé.

## Assistant privé de connexion des comptes

`sudo python3 deploy/connect-accounts.py telegram` demande le token BotFather avec saisie masquée. Utilisez un bot dédié à Rondivou : un webhook déjà existant provoque un arrêt sans remplacement. Le script vérifie le bot par `getMe`, affiche une commande `/start` avec un code aléatoire à envoyer au bot, et n'accepte que le même utilisateur dans une conversation privée. Il conserve cet ID comme unique administrateur et génère le secret du webhook. Après sauvegarde et rechargement du conteneur, ouvrez **Connexions > Connecter et tester Telegram** sur le site pour enregistrer le webhook et recevoir le message de test, puis envoyez `/start` au bot pour vérifier la réception.

`sudo python3 deploy/connect-accounts.py meta` demande l'App ID, le Page ID, l'App Secret et un Page Access Token obtenu via cette même application. Il contrôle la validité du token, son application d'origine, les permissions principales et la liaison à un compte Instagram professionnel. L'App Secret et les tokens restent masqués à la saisie. Le script conserve le token de vérification dans `/opt/rondivou/meta-verify-token` (privé) pour le saisir dans le tableau de bord Meta avec l'URL `/webhooks/meta`. Après configuration des abonnements Messenger et Instagram, testez chaque canal réellement ; la validation du token seule ne prouve pas la réception des messages ni l'autorisation d'envoyer des rappels.

Les scripts ne montrent jamais les tokens, ne changent pas le mot de passe et ne modifient pas les rendez-vous. Ils rechargent le conteneur avec la même image et les mêmes montages, puis vérifient sa santé locale. Un échec du rechargement déclenche une restauration des paramètres et du précédent conteneur. Test du helper sans appels externes : `python3 -m unittest discover -s test -p 'test_*.py'`.

Si aucune conversation n'arrive, `sudo python3 deploy/check-connections.py` réalise un diagnostic en lecture seule : présence des paramètres sauvegardés et chargés, abonnement webhook au niveau application, abonnement au niveau Page, nombre de messages stockés et compte des envois en attente. Il n'envoie aucun message, ne change aucun abonnement et ne montre ni les tokens ni le contenu des conversations. Les deux niveaux d'abonnement sont distincts ; la vérification de l'URL callback seule ne prouve pas l'abonnement à `messages`. En mode développement, vérifiez aussi que le compte de test possède un rôle dans l'application Meta.

Si l'abonnement de l'application Page est actif avec la bonne URL mais sans événements, l'option explicite `sudo python3 deploy/check-connections.py --repair-messenger` ajoute `messages` et `message_echoes`. Ce mode effectue une modification Meta, contrairement au diagnostic par défaut. Il relit les abonnements avant écriture, conserve les autres événements Page et les autres objets (notamment Instagram), refuse de remplacer un callback différent, et vérifie l'état après la réponse d'acceptation. Il ne redémarre pas le site et ne touche pas aux données clientes. Testez ensuite avec une nouvelle conversation depuis un utilisateur ayant un rôle dans l'application.

Le serveur journalise désormais les POST Meta sous l'événement `meta_webhook` : statut HTTP, raison de rejet ou acceptation, nombre d'entrées/messages textuels et catégories de changements. Aucun texte de message, identifiant client, token, signature ou paramètre d'URL n'est journalisé. Ce contrôle permet de distinguer l'absence de livraison Meta, une signature refusée et un format d'événement non traité. Pour un ancien EC2 utilisant le code initial, `sudo python3 deploy/install-webhook-audit.py <commit-sha>` installe uniquement `src/app.js` à une révision Git vérifiée, après contrôle du hash initial et de la syntaxe Node. Il conserve les fichiers locaux, refuse les versions modifiées inconnues et revient au code précédent si le redémarrage échoue. Le diagnostic reste à exécuter sur le serveur distant ; une modification dans GitHub seule n'active pas ces logs sur EC2.

Pour le parcours **Instagram avec Facebook Login**, `sudo python3 deploy/check-connections.py --repair-instagram` vérifie d'abord que l'ID Instagram configuré correspond au compte professionnel lié à la Page, puis lit l'abonnement **de cette Page**. Il ajoute `messages` à l'objet application `instagram` et vérifie `messages` et `message_echoes` sur l'abonnement Page, avec le Page Access Token existant. Il n'utilise pas `/IG_ID/subscribed_apps`, qui relève du parcours Instagram Login. L'objet application `page` et les autres événements de la Page restent conservés. Un callback Instagram différent ou une lecture refusée bloque la modification concernée. Si l'API masque les champs d'un abonnement existant, celui-ci est conservé et le rapport l'indique ; l'état des champs n'est pas présenté comme vérifié. Une réussite de configuration doit toujours être suivie d'une nouvelle DM de test et de la vérification des textes dans le site et Telegram. Les exigences de rôles de test, publication et accès avancé restent celles de Meta.

## Extraction IA avec FreeLLMAPI

Le connecteur utilise l'API compatible OpenAI `/v1/chat/completions` du routeur FreeLLMAPI. Sur le serveur du routeur, ajouter au moins une clé de fournisseur et un modèle capable de produire du JSON. Utiliser la **clé unifiée** de la page Keys du routeur dans Rondivou. Le routeur peut transmettre les textes aux fournisseurs configurés ; les quotas, la disponibilité et les règles de conservation dépendent de ces fournisseurs.

Variables : `AI_BASE_URL` (HTTPS, termine par `/v1`), `AI_API_KEY` (privée), `AI_MODEL` (`auto` par défaut). Les deux instances peuvent communiquer via Tailscale avec `tailscale serve` ; ne pas ouvrir le port 3001 sur Internet. Vérifier la connectivité depuis le conteneur applicatif, pas seulement depuis SSH.

Pour la version EC2 existante, télécharger `deploy/install-ai.py` depuis une **révision Git complète et fixe**, puis exécuter `sudo python3 /tmp/rondivou-ai.py <révision>`. Il vérifie les sources connues, conserve une copie privée des anciens fichiers, demande le secret sans l'afficher, teste une demande synthétique depuis le conteneur et réutilise la procédure de mise à jour de configuration avec retour à l'ancienne configuration en cas d'échec. Les changements de base sont additifs ; ni les réservations ni les mots de passe ne sont supprimés. Aucun nouveau fournisseur npm n'est nécessaire.

Les nouveaux textes sont conservés et transmis à Telegram comme avant. Une tâche persistante analyse les 30 derniers messages du contexte courant (limite de 100 000 caractères) ; les résultats sont enregistrés en base et proposés dans le formulaire du site. Les noms de compte proviennent de Meta, jamais du modèle. Nom réel et téléphone ne sont extraits que si explicitement écrits. Chaque champ doit fournir une citation existante ; les dates/heures/prestations sont validées par l'application. Cela réduit les erreurs du modèle, sans garantir son interprétation sémantique.

La création automatique nécessite date, heure et prestation sans ambiguïté, preuves de l'accord des deux parties, contexte non historique, aucun rendez-vous futur déjà lié à cette conversation et disponibilité du salarié. Une demande de modification/annulation reste manuelle. Une erreur ou réponse invalide du modèle n'entraîne aucun retour automatique à une réservation fondée sur les anciennes règles. Les réponses devenues obsolètes pendant l'analyse sont ignorées et un nouveau traitement est programmé. Les exceptions et erreurs du fournisseur ne sont jamais journalisées avec leur contenu brut.

Dans une conversation, « Analyser avec IA » relance l'analyse ; « rondivou » permet toujours de compléter les informations manuellement. Les anciennes conversations ne sont pas analysées automatiquement lors de l'installation. Une conversation historique reste soumise à validation manuelle, même si le modèle détecte un accord. Les tests automatisés utilisent un fournisseur simulé : la qualité réelle en darija et le fonctionnement de la chaîne FreeLLMAPI doivent être vérifiés avec des exemples après la connexion privée.

## Telegram : une carte par conversation

`TELEGRAM_COMPACT=true` remplace les envois séparés de textes, profils et analyses par une carte persistante et modifiable pour chaque conversation et compte Telegram administrateur. Les événements rapprochés sont regroupés pendant environ huit secondes ; la disponibilité de Telegram et la durée d'analyse IA peuvent retarder la livraison. La carte montre le profil, le rendez-vous futur éventuel, les données extraites et les trois derniers aperçus de textes, avec les boutons de gestion et un lien HTTPS vers le site. **L'historique intégral reste sur le site**, pas dans la carte. Le mode historique d'envoi de chaque texte reste disponible si la variable est absente ou différente de `true`.

La table additive `telegram_cards` conserve l'identifiant du message et son contenu après redémarrage. Un contenu inchangé n'est pas renvoyé. Un échec réseau ou une limitation Telegram déclenche un réessai ; il ne crée pas automatiquement une deuxième carte. Une carte supprimée ou devenue non modifiable peut être remplacée. Une confirmation de réservation, un rappel ou un conflit nécessitant une action conserve une alerte distincte ; le même conflit IA n'est pas signalé à chaque réanalyse identique. Les éditions de carte ne produisent pas une nouvelle notification sonore pour chaque texte.

Sur le déploiement EC2 ayant déjà reçu la connexion IA, télécharger `deploy/install-telegram-cards.py` depuis une révision Git complète et fixe et exécuter `sudo python3 /tmp/rondivou-cards.py <révision>`. Le programme conserve les identifiants existants, vérifie la version des fichiers, sauvegarde les sources, active uniquement `TELEGRAM_COMPACT=true`, redémarre avec les mêmes paramètres et vérifie `/health`. Il ne demande aucune clé. Les anciens messages déjà livrés à Telegram ne sont pas supprimés ; le premier nouvel événement crée la carte. Les anciennes tâches de transfert de texte/profil/analyse encore en attente sont regroupées dans la carte lors de leur traitement, en conservant les textes stockés sur le site.

## Interface lisible et dates des conversations

`deploy/install-workspace.py <révision complète>` installe en une fois le thème à fort contraste, les textes agrandis, les dates des premiers messages disponibles, les derniers messages en bas de chaque échange, les étiquettes FB:/IG: du calendrier et les cartes Telegram. Cette mise à jour accepte le déploiement IA initial ainsi que les deux correctifs de cartes/calendrier déjà installés. Elle sauvegarde les sources, conserve la configuration existante et active les cartes sans redemander de clés. Actualiser le navigateur avec Ctrl+F5 après le redémarrage.

Le champ API `started_at` est le minimum des dates des messages stockés, pas la date de création locale de la conversation. Il indique le **premier message disponible**, ce qui peut être plus récent que le véritable début de la conversation Meta lorsque l'import est limité au dernier mois. La liste des conversations reste triée par dernier échange décroissant ; les messages de chaque échange sont affichés du plus ancien au plus récent. L'ouverture d'un échange affiche le bas ; les actualisations suivent les nouvelles réponses si la lecture était déjà en bas et conservent la position pendant la lecture des messages anciens. La position de lecture est conservée lors des actualisations de la même conversation. Les créneaux du calendrier sont plus hauts pour garder les comptes et les horaires lisibles.

## Récupération des noms Meta manquants

Un webhook peut ne contenir qu'un identifiant opaque ; le nom ou pseudonyme nécessite une lecture du profil Meta. Les tâches de profil passent avant les longues analyses IA de l'historique, tout en respectant leurs délais de réessai. Une réponse sans nom n'est plus considérée comme une résolution réussie. L'import complète les conversations existantes qui n'avaient que leur identifiant, sans remplacer un pseudonyme déjà connu. Une réponse de profil en retard ne remplace pas un nom fourni entre-temps par l'import.

Au démarrage, les comptes non résolus sont remis en file sans doublonner les tâches ; les tentatives en échec reçoivent une nouvelle tentative immédiate unique puis retrouvent leur délai progressif. Les données de profil restent dépendantes des permissions, de la disponibilité et des restrictions Meta. Aucun nom n'est déduit des textes ni inventé par l'IA. `check-connections.py` expose des comptes agrégés `unresolved_profile_counts` et `profile_lookup_errors` avec uniquement les codes HTTP/Meta ou une catégorie générique, jamais le texte brut de l'erreur ni les identités des clients.

## IA réservée aux rendez-vous et mot de passe personnel

Le laboratoire, ses API et son traitement de style en arrière-plan sont supprimés. L'extraction des informations de rendez-vous via FreeLLMAPI reste active ; elle conserve ses règles de validation, d'accord et de disponibilité. Les anciennes tables de style, si présentes, restent inactives pour éviter toute suppression de données pendant la mise à jour. Aucun nouvel apprentissage de style n'est lancé.

`install-workspace.py` inclut ces modifications et les correctifs précédents. Les cartes du calendrier indiquent le numéro de téléphone enregistré, lorsqu'il existe, sous le compte FB:/IG:. Aucun numéro n'est inventé pour une fiche incomplète.

À la première ouverture après cette mise à jour, le mot de passe actuel permet de se connecter, puis le site exige un nouveau mot de passe différent d'au moins 16 caractères. Une empreinte scrypt avec sel aléatoire est conservée dans `admin_credentials`, sur le volume SQLite persistant. Le changement révoque les autres sessions. Les prochains redémarrages et installations préservent ce choix, même si `ADMIN_PASSWORD` ou `REQUIRE_PASSWORD_CHANGE=true` reste dans l'environnement. Le fichier `/opt/rondivou/admin-password` contient seulement le mot de passe initial et ne permet plus de se connecter après ce changement. Le bouton « Changer le mot de passe » dans Connexions permet un changement ultérieur avec vérification du mot de passe actuel.

En cas d'oubli, utiliser la version actuelle de `deploy/reset-admin-password.py` : elle met aussi à jour l'empreinte SQLite et révoque les sessions, sans toucher aux rendez-vous. Le mot de passe temporaire est lisible dans le fichier privé habituel ; la connexion suivante exige à nouveau un choix personnel. Sauvegarder la base SQLite inclut cette empreinte et permet de conserver le mot de passe choisi lors d'une restauration.

## Recherche dans les conversations

Le champ de recherche filtre les comptes et tous les textes enregistrés (messages entrants, sortants et historique importé). La recherche ignore la casse et les accents ; les caractères `%` et `_` sont littéraux. Les résultats restent triés par dernier échange, avec un aperçu du message correspondant le plus récent. Un clic ouvre la conversation et positionne la lecture sur ce message, mis en évidence. Effacer la recherche rétablit la liste complète. L'API exige la même session administrateur que les conversations ; aucun texte n'est envoyé au fournisseur IA pour cette recherche.

## Supprimer une conversation

Le bouton « Supprimer la conversation » dans l’échange demande confirmation. L’API administrateur supprime les messages locaux, les vérifications, les analyses IA, le suivi des cartes Telegram et les tâches de conversation, dans une transaction. Les anciens instantanés de style liés à cet échange sont aussi supprimés si ces tables existent. Les rendez-vous, leurs coordonnées, leur statut et les rappels restent conservés ; seuls leurs liens vers les messages sources supprimés sont retirés. Le compte et ses identifiants Meta restent en base pour conserver les libellés du calendrier et permettre les rappels existants. Une borne de suppression empêche les anciennes livraisons et les imports de remettre les messages effacés dans le site.

La conversation disparaît des listes, de la recherche et des accès directs. Un nouveau message en direct, postérieur à la suppression, réaffiche le compte avec uniquement les nouveaux échanges. Cela ne supprime rien dans Facebook, Instagram, les messages Telegram déjà reçus ou les sauvegardes existantes. Un appel externe déjà en cours peut se terminer ; son résultat IA n’est plus enregistré pour cet historique supprimé.

## Rappels à heures fixes et confirmation de présence

Tous les horaires sont ceux du salon, `Africa/Algiers` (UTC+1). Pour un début de rendez-vous entre 00:00 et 18:00 inclus, la première étape est à 19:00 la veille. Jusqu’à 13:00 inclus, c’est la seule étape. De 13:01 à 18:00 inclus, une deuxième étape est à 08:00 le jour même si la présence n’a pas été confirmée. Aucun rappel pour un début après 18:00. Les tâches Telegram et Meta sont distinctes pour chaque étape : un refus Meta n’empêche pas l’alerte au salon, et une panne Telegram ne bloque pas la tentative cliente. Les fenêtres et permissions Meta continuent de s’appliquer.

`reminder_events` conserve les étapes mises en file et leurs succès par canal, pour chaque version du rendez-vous. Le serveur ne les remet pas en file après un redémarrage. Les anciens envois à 24 heures non exécutés sont retirés ; les rappels déjà livrés et confirmations de présence existantes sont conservés. Une annulation, un changement d’horaire/prestation, une confirmation ou un début de rendez-vous rend les tâches concernées caduques. Changer seulement le téléphone, le nom ou la note conserve la confirmation et les étapes déjà exécutées.

Une réservation ou reprogrammation postérieure à une échéance ne provoque pas son envoi immédiat : seules les étapes encore à venir restent possibles. Exemple : réservation d’un rendez-vous à 15:00 après 19:00 la veille, mais avant 08:00 le jour même : seule l’étape de 08:00 est possible. Une réservation après 08:00 pour ce même jour n’a pas de rappel planifié. En cas de redémarrage tardif, une étape échue peut être rattrapée avant le début du rendez-vous ; lorsque l’étape de 08:00 s’ouvre, les tâches de la veille encore non envoyées expirent pour éviter un double rappel.

Après livraison du rappel Meta, le rendez-vous attend une confirmation de présence. Un accord entrant explicite (`je confirme`, ou une réponse courte comme `oui` dans ce contexte), non historique et postérieur au rappel, confirme uniquement s’il n’y a qu’un seul rendez-vous en attente pour ce compte et aucune date/heure/prestation contradictoire. Les réponses ambiguës nécessitent une vérification humaine. `attendance_confirmed_at` conserve la date de confirmation ; le salon reçoit une notification Telegram avec le compte et l’horaire. Le bouton « Confirmer la présence » du calendrier produit le même arrêt de relance. La réservation initiale, même confirmée, n’est pas une confirmation de présence après rappel.

La base doit rester persistante et le serveur actif. Les heures indiquées sont des échéances de mise en file ; les envois dépendent du traitement et des services distants. Les tests utilisent une horloge contrôlée et des réponses Telegram/Meta simulées, sans envoi réel à des clientes.
