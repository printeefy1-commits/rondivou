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
