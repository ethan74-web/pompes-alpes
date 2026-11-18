# Pompes des Alpes du Nord : carte de prévision de vol à voile

Vercors, Chartreuse, Belledonne, Taillefer, Bauges, Bugey, Bornes, Aravis, Beaufortain, Haut-Giffre, Mont-Blanc.

Site statique : aucun serveur à faire tourner. Tout est calculé dans le navigateur (dans un Web Worker) à partir de :
- `data/` : le relief SRTM en mailles de 150 m (altitude, nature du sol, facteur de vue du ciel), produit par `tools/export_terrain.py` ;
- `data/meteo/` : les journées sèches passées du modèle par défaut (juin à septembre des deux dernières années, 92 derniers jours),
  stockées par `tools/archive_meteo.py` ; mises à jour chaque nuit par l'action GitHub `.github/workflows/archive.yml` ;
- l'API publique Open-Meteo (sans clé) pour le reste : prévisions, journées pluvieuses, autres modèles.

La théorie complète est dans `theorie.html` (lien discret en bas du panneau).

## Lancer en local

```
python site/tools/serve.py 8124
```
puis ouvrir http://localhost:8124.

## Fichiers

- `js/model.js` : physique (rayonnement, ombres, bilan d'énergie, sommet des thermiques par particule, vent ajusté au relief,
  brises et chaleur collectée, thermique + panache, Vz en spirale, incertitudes, alimentation d'une pompe)
- `js/worker.js` : calcul en arrière-plan, heure par heure ; comparaison des modèles
- `js/app.js` : carte et interface
- `js/weather.js` : requêtes Open-Meteo et lecture des archives stockées
- `js/scales.js` : échelles de couleur

## Quota Open-Meteo

L'API gratuite accepte 10 000 « appels » par jour et 600 par minute, par adresse IP ; une journée de 49 points et 59 variables
en coûte environ 290. Les archives stockées ne coûtent rien ; une comparaison des 6 modèles coûte environ 1 750 et prend
2 à 3 minutes (le site attend quand la limite par minute est atteinte).

## Recalage

Les paramètres recalés sur des vols sont regroupés dans `PARAM` (`js/model.js`) et dans la fonction `uncertainty` (écarts types).
Le banc d'essai `calib/` (non publié, servi en local) compare le modèle aux relevés ; `tools/save_day.py` y enregistre une journée
pour ne pas réinterroger l'API à chaque essai.

Modèle expérimental : ordres de grandeur, pas une garantie.
