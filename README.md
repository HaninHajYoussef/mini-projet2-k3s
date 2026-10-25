# Mini-projet 2 : application trois niveaux sur k3s

Gestionnaire de tâches : **frontend** (nginx-unprivileged), **API** (Node.js / Express), **base** (PostgreSQL 16).
Déployé sur un cluster k3s, dans le namespace `todo-app`, avec configuration externalisée, données persistantes, sauvegarde planifiée, RBAC, durcissement des Pods et NetworkPolicies.

Images (Docker Hub, publiques) :
- `haninhajyoussef/todo-api:1.0.0`
- `haninhajyoussef/todo-frontend:1.0.0`
- `postgres:16-alpine`

## Structure du dépôt

```
app/                     code et Dockerfile des composants, docker-compose pour le test local
k8s/
  00-namespace/          Namespace (label Pod Security baseline), ResourceQuota, LimitRange
  10-config/             ConfigMap app-config
  20-db/                 Service headless, StatefulSet, backup-pvc, CronJob, Pod utilitaire backup-tools
  30-app/                API, frontend, ConfigMap nginx, Ingress
  40-security/           ServiceAccounts, Role et RoleBinding, NetworkPolicies
secret.example.yaml      modèle du Secret (fausses valeurs)
```

## Prérequis

- Cluster k3s fonctionnel (Traefik et StorageClass `local-path` par défaut), `kubectl` configuré
- Accès Internet des nœuds pour télécharger les images Docker Hub
- Ligne dans le fichier `hosts` du poste client : `<IP_DU_MASTER>  app.k3s.local`

## Test local (facultatif)

```bash
cd app
docker compose up --build
# http://localhost:8090
```

## Ordre de déploiement

```bash
# 1. Namespace, quota, limites
kubectl apply -f k8s/00-namespace/
kubectl config set-context --current --namespace=todo-app

# 2. Secret (jamais versionné : créé directement dans le cluster)
kubectl create secret generic db-credentials \
  --from-literal=POSTGRES_USER=<utilisateur> \
  --from-literal=POSTGRES_PASSWORD=<mot_de_passe>

# 3. Configuration
kubectl apply -f k8s/10-config/

# 4. ServiceAccounts et RBAC (avant les Pods qui les utilisent)
kubectl apply -f k8s/40-security/10-serviceaccounts.yaml -f k8s/40-security/20-rbac-viewer.yaml

# 5. Base de données, puis sauvegarde
kubectl apply -f k8s/20-db/10-service-db.yaml -f k8s/20-db/20-statefulset-db.yaml
kubectl wait --for=condition=Ready pod/db-0 --timeout=180s
kubectl apply -f k8s/20-db/30-backup-pvc.yaml -f k8s/20-db/40-cronjob-backup.yaml -f k8s/20-db/50-backup-tools.yaml

# 6. API, frontend, Ingress
kubectl apply -f k8s/30-app/

# 7. NetworkPolicies (en dernier)
kubectl apply -f k8s/40-security/30-networkpolicies.yaml
```

Application : http://app.k3s.local

Le CronJob s'exécute toutes les 5 minutes (valeur de démonstration). Pour le suspendre ou le réactiver :
```bash
kubectl patch cronjob db-backup -p '{"spec":{"suspend":true}}'
kubectl patch cronjob db-backup -p '{"spec":{"suspend":false}}'
```

## Sauvegarde et procédure de restauration

Sauvegarde immédiate :
```bash
kubectl create job --from=cronjob/db-backup test-backup
kubectl exec backup-tools -- ls -l /backup        # fichiers dump-AAAAMMJJ-HHMM.sql
```

Restauration (remplacer le nom du dump par un fichier valide, de préférence un dump récent) :
```bash
kubectl exec -it db-0 -- psql -U <utilisateur> -d tododb -c "DROP TABLE tasks;"
kubectl exec backup-tools -- psql -h db -U <utilisateur> -d tododb -f /backup/dump-AAAAMMJJ-HHMM.sql
kubectl exec -it db-0 -- psql -U <utilisateur> -d tododb -c "SELECT * FROM tasks;"
```
Lancer ces trois commandes à la suite : l'API recrée une table vide à son démarrage, ce qui provoque des erreurs `already exists` (sans gravité) si elle redémarre entre-temps.

Attention : avec `local-path`, `backup-pvc` et le volume de la base sont sur le même nœud. Pour une vraie protection, copier les dumps hors du nœud.

## Vérifications

```bash
kubectl get pods,svc,ingress,pvc,networkpolicy

# RBAC : attendu yes, yes, no, no
kubectl auth can-i list pods     --as=system:serviceaccount:todo-app:dev-viewer
kubectl auth can-i get pods/log  --as=system:serviceaccount:todo-app:dev-viewer
kubectl auth can-i delete pods   --as=system:serviceaccount:todo-app:dev-viewer
kubectl auth can-i get secrets   --as=system:serviceaccount:todo-app:dev-viewer

# Durcissement
kubectl exec deploy/api -c api -- id                    # uid=1000 (non root)
kubectl exec deploy/api -c api -- touch /testfile       # Read-only file system
kubectl exec deploy/api -c api -- ls /var/run/secrets/kubernetes.io/serviceaccount   # absent
```

Test des NetworkPolicies (Pod de test sans label) :
```bash
kubectl run nettest --image=busybox:1.36 --restart=Never -- sleep 3600
kubectl exec nettest -- sh -c 'nc -z -w 3 db 5432 && echo OUVERT || echo BLOQUE'          # BLOQUE
kubectl exec deploy/frontend -- sh -c 'nc -z -w 3 db 5432 && echo OUVERT || echo BLOQUE'  # BLOQUE
kubectl exec deploy/api -c api -- sh -c 'nc -z -w 3 db 5432 && echo OUVERT || echo BLOQUE' # OUVERT
kubectl delete pod nettest
```

## Matrice des flux réseau

| Source | Destination | Autorisé |
|---|---|---|
| Traefik (kube-system) | frontend | Oui |
| frontend | api (3000) | Oui |
| api | db (5432) | Oui |
| job de sauvegarde | db (5432) | Oui |
| frontend | db | Non |
| tout autre Pod | api, db | Non |

## Sécurité : points à retenir

- Aucun secret dans Git : le Secret est créé avec `kubectl create secret`, `secret.example.yaml` ne contient que de fausses valeurs.
- Pods applicatifs non-root, `allowPrivilegeEscalation: false`, capabilities supprimées, système de fichiers en lecture seule (API, frontend), seccomp `RuntimeDefault`.
- Exception justifiée : la base n'a pas `readOnlyRootFilesystem` (PostgreSQL écrit son socket et des fichiers temporaires hors du volume).
- Pod Security : niveau `baseline` appliqué au namespace ; le niveau `restricted` est respecté par l'API, le frontend et la base, seuls les Pods de sauvegarde (sans `securityContext`) ne le respectent pas.
