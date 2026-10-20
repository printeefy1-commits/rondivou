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
