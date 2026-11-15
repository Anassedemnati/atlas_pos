# Atlas POS : guide du technicien

Ce guide est celui de la personne qui installe et dépanne une caisse. Il suit l'ordre d'une installation : le poste, le logiciel, l'assistant de première configuration, le matériel, les sauvegardes, puis la vie de la caisse (menu technicien, profils, restauration, dépannage).

## 1. Avant de partir chez le client

À emporter sur une clé USB (le « kit technicien ») :

- l'installateur : `AtlasPOS-Setup-<version>.exe` (Windows) ou `AtlasPOS-<version>-linux-amd64.deb` (Linux) ;
- si le client a déjà une caisse Atlas POS : le fichier de profil `*.atlasprofile` exporté depuis cette caisse (voir § 8) ;
- ce guide, imprimé ou sur le téléphone.

Demandez au client :

- ICE, IF, RC, patente, raison sociale, nom commercial, adresse, ville, téléphone (ils figurent sur chaque ticket) ;
- les noms du personnel et le code PIN de chacun (4 à 6 chiffres, un PIN différent par personne) ;
- le logo, si le client veut l'imprimer sur ses tickets (PNG, JPG, WebP ou SVG, 2 Mo au plus).

## 2. Le poste

### Matériel conseillé

| Élément | Minimum conseillé |
|---|---|
| Ordinateur | 64 bits (x64), 4 Go de RAM, 20 Go libres, disque SSD |
| Écran | tactile 15 pouces ou plus (cibles tactiles de 64 px) |
| Système | Windows 10 ou 11 (64 bits) ; Linux Debian/Ubuntu (64 bits) |
| Second disque ou clé USB | pour les sauvegardes (obligatoire en pratique : voir § 5) |
| Onduleur | fortement conseillé (l'application survit aux coupures, un onduleur évite d'en avoir) |

### Imprimantes et périphériques pris en charge

L'application parle ESC/POS, le langage de presque toutes les imprimantes de tickets 58 et 80 mm. Six types de connexion existent dans l'assistant (étape Matériel) :

| Type | Quand l'utiliser | Adresse à saisir |
|---|---|---|
| Réseau (IP) | imprimante Ethernet ou Wi-Fi | adresse IP et port (9100 en général) ; réservez l'adresse IP dans le routeur |
| Port série | imprimante USB-série ou RS-232 | `COM3@9600` (Windows) ou `/dev/ttyUSB0@9600` (Linux) |
| Fichier périphérique (USB) | Linux, imprimante USB | `/dev/usb/lp0` ; l'utilisateur de la caisse doit avoir le droit d'écrire (groupe `lp`) |
| Imprimante Windows | Windows, imprimante USB installée avec son pilote | le nom exact de l'imprimante dans « Imprimantes et scanners » ; les octets ESC/POS partent en mode RAW |
| Imprimante du système | A4, factures, ou modèle non ESC/POS | le nom de l'imprimante du système |
| Virtuelle (test) | essais sans matériel | rien : chaque ticket devient un fichier dans `prints/` (voir `docs/TESTING.md`) |

Autres périphériques :

- Tiroir-caisse : branché sur l'imprimante de tickets (prise RJ11), ouvert par une impulsion ESC/POS. Testez-le avec le bouton « Ouvrir le tiroir » de l'assistant.
- Imprimante cuisine et bar : une imprimante par poste, avec le routage catégorie vers imprimante défini à l'étape Matériel (par défaut selon le rôle de l'imprimante).
- Lecteur de codes-barres : en mode « clavier » (il tape les chiffres puis Entrée). Un champ de test est dans l'assistant.
- Second écran : écran client en plein écran, activé à l'étape Matériel.
- Tickets en arabe : rendus en image, donc corrects même sur une imprimante sans page de code arabe (cochez « raster » sur l'imprimante si le texte arabe sort mal).

## 3. Réglages du poste (à faire une fois, avant l'installation)

Ces réglages sont ceux qui font que la caisse revient seule après une coupure de courant. L'assistant les rappelle à la dernière étape, mais il ne peut pas les faire à votre place.

1. BIOS / UEFI : activer « Power on after AC loss » (aussi appelé « Restore on AC Power Loss », « AC Back », « After Power Loss » : choisir « Power On »). Ainsi le poste redémarre dès que le courant revient.
2. Ouverture de session automatique pour l'utilisateur de la caisse :
   - Windows : `Win + R`, `netplwiz`, décocher « Les utilisateurs doivent entrer un nom et un mot de passe », saisir le mot de passe de l'utilisateur. Si la case n'existe pas (Windows 11 avec Windows Hello), utiliser l'outil Autologon de Sysinternals.
   - Linux : activer la connexion automatique dans le gestionnaire de session (GDM : Paramètres, Utilisateurs, « Connexion automatique » ; LightDM : `autologin-user=` dans `/etc/lightdm/lightdm.conf`).
3. Désactiver la mise en veille et l'extinction de l'écran :
   - Windows : `powercfg /change standby-timeout-ac 0`, `powercfg /change monitor-timeout-ac 0`, `powercfg /change hibernate-timeout-ac 0`, et désactiver le démarrage rapide (Options d'alimentation, « Choisir l'action des boutons d'alimentation »).
   - Linux : Paramètres, Alimentation, « Mise en veille automatique » sur « Désactivée ».
4. Mises à jour Windows : définir les heures d'activité sur les heures d'ouverture du commerce, pour éviter un redémarrage en plein service.
5. Pare-feu (seulement si l'on veut le back office depuis un autre poste) : autoriser l'application sur les réseaux privés quand Windows pose la question.

## 4. Installation pas à pas

### Windows

1. Copiez `AtlasPOS-Setup-<version>.exe` sur le poste et double-cliquez dessus.
2. Windows SmartScreen affiche « Windows a protégé votre ordinateur » : l'installateur n'est pas signé dans cette version. Cliquez sur « Informations complémentaires », puis « Exécuter quand même ».
3. Acceptez l'élévation (administrateur) : l'installation est faite pour tous les utilisateurs du poste.
4. Gardez le dossier proposé (`C:\Program Files\Atlas POS`) sauf besoin particulier, puis « Installer ».
5. Fin d'installation : cochez « Exécuter Atlas POS », l'assistant de première configuration démarre (§ 5). Un raccourci est créé sur le Bureau et dans le menu Démarrer.

Ce que fait l'installateur, bon à savoir pour dépanner :

- Il crée `C:\ProgramData\AtlasPOS` (base de données, journaux, sauvegardes locales, configuration) et donne le droit de modification au groupe Utilisateurs : tous les comptes Windows du poste partagent les mêmes données.
- Les données ne sont jamais dans le dossier du programme. Une mise à jour (relancer un installateur plus récent) ne touche pas aux données.
- La désinstallation (Paramètres, Applications) demande « Supprimer aussi les données ? ». La réponse par défaut est Non. Répondez Oui seulement sur un poste qu'on met au rebut, après avoir vérifié qu'une sauvegarde existe ailleurs.

### Linux, paquet .deb

```bash
sudo apt install ./AtlasPOS-<version>-linux-amd64.deb
```

- Le paquet crée `/var/lib/atlas-pos` (droits 0777 : un seul poste de caisse, quel que soit l'utilisateur qui s'y connecte).
- Lancez « Atlas POS » depuis le menu des applications, ou `atlas-pos` dans un terminal.
- Si le sandbox de Chromium est refusé (conteneur, certaines machines virtuelles) : `atlas-pos --no-sandbox`.

### Linux, AppImage

```bash
chmod +x AtlasPOS-<version>-linux-x86_64.AppImage
./AtlasPOS-<version>-linux-x86_64.AppImage
```

- Sur Ubuntu 22.04 et suivants, installez `libfuse2` si l'AppImage ne démarre pas.
- Sans `/var/lib/atlas-pos`, les données vont dans `~/.local/share/atlas-pos`.

### macOS (essais seulement)

Le `.dmg` n'est pas signé (aucun certificat Apple en version 1) : voir `docs/TESTING.md`. Les données sont dans `~/Library/Application Support/AtlasPOS`.

## 5. L'assistant de première configuration

Au premier lancement, sur un dossier de données vide, l'application ouvre l'assistant. L'état est enregistré à chaque étape : une coupure de courant pendant l'installation reprend là où elle s'est arrêtée.

| Étape | À faire |
|---|---|
| 0 · Départ | « Nouvelle installation », « Importer un profil » (fichier `.atlasprofile`) ou « Restaurer une sauvegarde » (reprise après sinistre sur un nouveau poste, voir § 9) |
| 1 · Langue | langue de l'assistant, langue des tickets, langue par défaut du personnel (français, arabe, anglais) |
| 2 · Type d'activité | restaurant, café, boulangerie ou commerce : les modules et le catalogue d'exemple se préparent. Source du catalogue : exemple du modèle, import Excel/CSV (avec aperçu des erreurs) ou vide |
| 3 · Entreprise | raison sociale, nom commercial, adresse, ville, téléphone, ICE, IF, RC, patente, logo, taux de TVA, en-tête et pied des tickets. L'aperçu du ticket 80 mm se met à jour en direct |
| 4 · Matériel | ajouter les imprimantes (§ 2), faire la page de test de chacune, tester le tiroir, choisir le routage cuisine et bar, activer le second écran |
| 5 · Utilisateurs | le gérant (PIN pour la caisse, plus identifiant et mot de passe de 8 caractères au moins pour le back office), puis le personnel avec un profil (Gérant, Caissier, Serveur). Le code technicien (6 caractères au moins) est un secret à part, différent de tous les PIN |
| 6 · Sauvegardes | les destinations (§ 6), chacune avec son test, le calendrier et la rétention, le démarrage automatique avec le système et le mode caisse plein écran. La liste de contrôle du technicien (§ 3) est rappelée ici |
| Résumé | relire, puis « Terminer » : l'application crée la base, installe le catalogue, fait une première sauvegarde complète sur chaque destination, enregistre le démarrage automatique, puis ouvre l'écran de connexion |

Conseils :

- Notez le code technicien et remettez-le au gérant sous enveloppe : sans lui, le menu technicien est fermé et il n'y a pas de procédure de récupération.
- Après « Terminer », l'assistant propose d'exporter le réglage comme profil : faites-le, la clé USB du kit sert pour la prochaine caisse du même client.
- En mode caisse plein écran, la fenêtre ne se ferme pas avec Alt+F4. Pour sortir : menu technicien, onglet Quitter.

## 6. Sauvegardes

### Principe

Chaque sauvegarde est un instantané SQLite compressé (`.atlasbak`) accompagné d'un fichier manifeste `.json` (somme SHA-256, version, nombre de lignes par table). Elle est vérifiée avant d'être déclarée bonne.

| Type | Quand | Où |
|---|---|---|
| Continue (« live ») | après chaque ticket encaissé, au plus une fois par minute | une copie qui se remplace, sur chaque destination disponible |
| Complète | à chaque clôture Z, avant une migration, avant une restauration, avant un changement du technicien, et à la demande | une copie datée, sur chaque destination, plus une copie locale dans `<données>/backups/` |

Les destinations (étape Sauvegardes) :

- Second disque : un dossier sur un autre disque ou une autre partition (par exemple `D:\AtlasBackup`).
- Clé ou disque USB : la copie se fait dès que la clé est branchée.
- NAS : un dossier partagé (`\\NAS\caisse`) ou un lecteur réseau monté.

Sur chaque destination, l'application crée un dossier `AtlasBackup` (avec un fichier marqueur `.atlas-target`, `full/` et `live/`). Ne renommez rien dans ce dossier.

À savoir :

- Le test d'une destination écrit, relit et vérifie un fichier : un voyant vert dans l'assistant est une vraie preuve.
- Une destination absente (clé débranchée, NAS éteint) est mise en attente : la copie se fait quand elle revient. Au bout de 24 h sans copie réussie, un avertissement orange s'affiche dans la barre du haut de la caisse.
- La rétention par défaut est de 30 jours : toutes les copies datées des 30 derniers jours sont gardées, plus la plus récente de chaque mois sur 12 mois, et toujours les 3 plus récentes. Les plus anciennes sont supprimées automatiquement.
- Les sauvegardes ne sont pas chiffrées dans cette version (réseau local seulement) ; rangez les clés USB comme de l'argent.

### Sauvegarder à la main

Menu technicien, onglet Sauvegardes, « Sauvegarder maintenant ». Faites-le avant toute intervention lourde, et après avoir terminé l'installation si vous avez changé quelque chose.

### Contrôle de routine (à chaque visite)

1. La pastille de sauvegarde de la barre du haut est verte.
2. Menu technicien, Sauvegardes : la dernière entrée a moins de 24 h et existe sur chaque destination (rôle `disk`, `usb`, `nas`).
3. Une fois par an : restaurer une copie sur un autre poste (§ 9) pour être sûr qu'elle se relit.

## 7. Le menu technicien

Ouverture : appuyer 0,8 seconde sur le logo, en haut à gauche de l'écran de caisse, puis saisir le code technicien. Un mauvais code affiche « Code technicien incorrect » et n'ouvre rien. Le menu est aussi disponible depuis l'écran de reprise après incident.

| Onglet | Contenu |
|---|---|
| Modules | activer ou désactiver les modules (plan de salle et tables, cuisine, menus et formules, clients, stock, code-barres, balance) ; rechargez l'écran de caisse après modification |
| Matériel | la liste des imprimantes configurées et un bouton « Page de test » pour chacune |
| Sauvegardes | l'état, « Sauvegarder maintenant », la liste des copies avec « Restaurer » (§ 9) |
| Profil | « Exporter le profil » et « Importer un profil » (§ 8) |
| Journal | les dernières lignes du journal de l'application |
| Quitter | « Redémarrer normalement » (sort du mode sécurisé) ou « Quitter vers le bureau » (la caisse ne vend plus tant qu'elle n'est pas relancée) |

Une sauvegarde complète est faite avant tout changement appliqué depuis ce menu.

## 8. Profils d'installation (`.atlasprofile`)

Un profil est un fichier compressé qui reprend les réglages d'une caisse pour en installer une autre à l'identique : type d'activité et modules, réglages, catalogue, claviers, imprimantes (sans les chemins propres au poste), profils de permissions.

Il ne contient jamais de ventes, ni de PIN, ni de mot de passe.

- Exporter : menu technicien, Profil, « Exporter le profil » (ou à la fin de l'assistant). Le fichier est enregistré à l'endroit choisi, par exemple la clé USB du kit.
- Importer à l'installation : étape 0 de l'assistant, « Importer un profil ». Toutes les étapes sont pré-remplies. L'identité légale (ICE, IF, RC) vient du profil : l'assistant exige de la confirmer à l'étape Entreprise avant de terminer. Les imprimantes sont à rebrancher et à retester sur le nouveau poste.
- Importer sur une caisse en service : menu technicien, Profil, « Importer un profil » : les produits du profil sont ajoutés (le message indique le nombre de produits ajoutés).

## 9. Restauration

Quatre situations, de la plus fréquente à la plus rare.

### Après une coupure de courant ou un plantage

Rien à faire. Au redémarrage, l'application détecte l'arrêt brutal, vérifie la base, remet les tables et commandes ouvertes comme elles étaient et affiche l'écran de reprise : les contrôles faits, les tables retrouvées, l'heure de la dernière sauvegarde. « Continuer » mène à la connexion par PIN. Les tickets déjà encaissés ne sont ni perdus ni dupliqués.

Les impressions dont le résultat est incertain sont présentées « à réimprimer ? » : elles ne repartent jamais sans décision d'une personne.

Un watchdog relance l'application si elle plante. Après 3 plantages en 5 minutes, elle démarre en mode sécurisé (rien ne s'imprime) avec les choix « restaurer une sauvegarde » et le journal : cherchez la cause dans le journal (§ 10), puis menu technicien, Quitter, « Redémarrer normalement ».

### Base abîmée

Si le contrôle d'intégrité échoue, l'écran de reprise propose la dernière sauvegarde vérifiée et garde le fichier abîmé à part (`db/corrupt-<date>.db`). Choisissez la copie la plus récente, restaurez, et notez au client la période éventuellement perdue (les ventes faites depuis la copie).

### Restaurer une copie précise

Menu technicien, Sauvegardes, choisir la copie, « Restaurer », confirmer. La copie est vérifiée, puis elle remplace la base ; la base précédente est gardée sous `db/pre-restore-<date>.db`. L'application redémarre sur la base restaurée. Les droits de restauration sont réservés au gérant et au technicien.

### Poste neuf après un sinistre

1. Installez Atlas POS (§ 4) sur le nouveau poste.
2. Branchez la clé ou le disque qui porte le dossier `AtlasBackup` (ou montez le partage du NAS).
3. Dans l'assistant, étape 0 : « Restaurer une sauvegarde », choisissez le dossier de sauvegarde puis la copie la plus récente.
4. Vérifiez le matériel : les imprimantes sont à reconfigurer (menu technicien, Matériel) si les chemins ont changé.

## 10. Dépannage

| Où | Quoi |
|---|---|
| `<données>/logs/app.log` | le journal de l'application, une ligne JSON par événement (le menu technicien en montre la fin) |
| `<données>/logs/fatal.log` | la raison d'un arrêt qui empêche de démarrer |
| `<données>/db/` | `atlas.db`, plus `corrupt-*.db` et `pre-restore-*.db` si un incident a eu lieu |
| `<données>/backups/` | les copies locales (`.atlasbak` et `.json`), `live/`, et les `pre-migration-*.db` |
| `<données>/prints/` | les tickets des imprimantes virtuelles |
| `<données>/config/` | `installation.json`, `wizard-draft.json`, `running.lock` |

Dossier de données `<données>` : Windows `C:\ProgramData\AtlasPOS`, Linux `/var/lib/atlas-pos` (ou `~/.local/share/atlas-pos`), macOS `~/Library/Application Support/AtlasPOS`.

Cas courants :

- L'application ne démarre pas, ou se ferme aussitôt : lisez `logs/fatal.log`. Un message d'accès refusé sur `config/` veut dire que l'utilisateur n'a pas les droits sur le dossier de données (Windows : relancez l'installateur, il rétablit les droits du groupe Utilisateurs).
- Rien ne s'imprime : pastille imprimante rouge ou orange dans la barre du haut. Menu technicien, Matériel, « Page de test ». Réseau : l'imprimante répond-elle au ping ? Windows : le nom de l'imprimante est-il exactement celui du système ? Les tickets non imprimés restent dans la file et repartent seuls quand l'imprimante revient (sauf ceux dont le résultat est incertain).
- Le back office ne répond pas : l'adresse est `http://<adresse IP du poste>:8080/admin` (port réglé à l'assistant). Il n'accepte que le réseau local. Vérifiez le pare-feu Windows (réseaux privés) et que le port n'est pas pris par un autre programme (le journal dit `backoffice.listen_failed`).
- Une seconde fenêtre s'ouvre ou rien ne se passe au double-clic : une seule instance tourne à la fois, la seconde ramène la première au premier plan.
- Variable d'environnement `ATLAS_DATA_DIR` : change le dossier de données (essais, clé portable). Ne l'utilisez pas sur une caisse en production.

## 11. Mise à jour

Lancez l'installateur d'une version plus récente par-dessus l'ancienne (Windows) ou `sudo apt install ./<nouveau>.deb` (Linux). Les données restent en place. Au premier démarrage, la base est migrée si nécessaire, après une copie automatique de sécurité (`backups/pre-migration-<date>-v<n>.db` dans le dossier de données). Faites une sauvegarde complète à la main juste avant, c'est gratuit.

Revenir à une version précédente n'est pas prévu : une base déjà migrée par une version plus récente est refusée par l'ancienne (écran « Mise à jour requise »), et aucune restauration n'est proposée à ce moment, ce n'est pas la solution. Installez la version récente.
