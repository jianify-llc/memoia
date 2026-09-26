# Modified for Memoia: use the renamed internal server package.
set -e

# python ./api/build_init_sql.py > ./db/init.sql

# Get the value of __version__ from memoia_server.__init__
version=$(grep -oE '__version__ *= *"[^"]+"' ./api/memoia_server/__init__.py | awk -F'"' '{print $2}')
echo "Version: $version"
echo "# Synced from backend ${version}" > ../client/memobase/core/blob.py
cat ./api/memoia_server/models/blob.py >> ../client/memobase/core/blob.py