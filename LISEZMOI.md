# Pompes des Alpes du Nord : carte de prévision de vol à voile

Chartreuse, Belledonne, Bauges, Bornes, Aravis, Beaufortain, Haut-Giffre, Mont-Blanc.

Site statique : aucun serveur à faire tourner. Tout est calculé dans le navigateur (dans un Web Worker) à partir de :
- `data/` : le relief SRTM en mailles de 150 m (altitude, nature du sol, facteur de vue du ciel), produit par `tools/export_terrain.py` ;
- l'API publique Open-Meteo (sans clé) : prévisions de J-1 à J+5 et archives de prévisions depuis 2022.

La théorie complète est dans `theorie.html` (lien discret en bas du panneau).

## Lancer en local

```
python site/tools/serve.py 8124
```
puis ouvrir http://localhost:8124.

## Fichiers

- `js/model.js` : physique (rayonnement, ombres, bilan d'énergie, brises, thermique, Vz en spirale, incertitudes)
- `js/worker.js` : calcul en arrière-plan, heure par heure
- `js/app.js` : carte et interface
- `js/weather.js` : requêtes Open-Meteo
- `js/scales.js` : échelles de couleur

## Recalage

Les paramètres à recaler sur des vols sont regroupés dans `PARAM` (`js/model.js`) et dans la fonction `uncertainty` (écarts types a priori).

Modèle expérimental : ordres de grandeur, pas une garantie.
