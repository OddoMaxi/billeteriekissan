# Gabarit des billets : consignes pour le graphiste

**Cinq tickets par feuille A4 portrait** : chaque ticket mesure **210 × 59,4 mm** (297 ÷ 5).

Fichiers de référence (servis par l'application, dossier `public/gabarit/`) :

- `gabarit-zones.pdf` : gabarit coté, zones réservées en rouge, marges de sécurité en bleu ;
- `billet-demo.pdf` : exemple de fond prêt à importer (PDF vectoriel) ;
- `billet-demo.png` : le même en PNG 300 dpi (2 480 × 702 px).

## Format

| Élément | Valeur |
| --- | --- |
| Format du ticket | **210 × 59,4 mm**, horizontal (un cinquième d'A4 portrait) |
| Fichier accepté | PDF d'**une seule page** (recommandé), PNG ou JPEG ; 15 Mo maximum |
| Résolution des images | 300 dpi minimum, soit **2 480 × 702 px** pour un PNG ou un JPEG |
| Proportions | exactement 210 / 59,4 (tolérance 1 %). Un fichier aux mauvaises proportions est **refusé** : il n'est jamais étiré ni recadré |
| Fond perdu | aucun ; ne pas ajouter de marge autour du ticket |

## Talon

Ligne de détachement verticale à **x = 155 mm** : le corps va de 0 à 155 mm, le talon de 155 à 210 mm (55 mm).

## Zones réservées : laisser vierges (fond clair uni)

Cotes en mm, mesurées depuis le **coin haut-gauche** du ticket.

| Zone | x | y | largeur | hauteur |
| --- | --- | --- | --- | --- |
| Numéro, corps | 117 | 9 | 32 | 8 |
| QR code, corps | 118 | 20 | 30 | 30 |
| Numéro, talon | 162,5 | 9 | 40 | 8 |
| QR code, talon | 167,5 | 20 | 30 | 30 |

- Le **numéro** (001, 002…, sans préfixe ; **chaque catégorie a sa propre numérotation**) est imprimé en noir, Helvetica gras 16 pt, centré dans sa zone. Imprimez la **catégorie** (VIP, Standard…) dans le design : c'est elle qui distingue deux billets de même numéro.
- Le **QR code** est imprimé en noir sur un carré blanc qui inclut sa marge vierge. Placez-le sur un fond **clair** : un panneau blanc de 3 mm autour des zones, comme sur le design de démonstration, est recommandé.
- Le même numéro et le même QR sont imprimés sur le corps et sur le talon. Ils désignent **un seul billet**, qui ne donne droit qu'à **une seule entrée**.
- Le design ne doit contenir **aucun numéro ni QR** : ils sont ajoutés automatiquement à la génération.

## Marges de sécurité

Aucun élément important (texte, logo) à moins de **4 mm** d'un bord de coupe : bords du ticket et ligne du talon.
À l'impression, le ticket est réduit à environ 95 % pour tenir dans la zone imprimable (profil 5 mm : 200 × 56,6 mm) ;
le QR mesure alors environ 28,6 mm, ce qui reste très confortable pour un flasheur.

## Si votre design s'écarte du gabarit

Les zones se déplacent dans l'application (onglet « Modèles de billets » de l'événement) : glisser-déposer ou saisie
des cotes, avec contrôle immédiat des marges et des chevauchements. Chaque modèle passe ensuite par un **BAT**
(une planche A4 de 5 spécimens) imprimé à 100 % et lu avec le flasheur réel avant de pouvoir servir en production.
