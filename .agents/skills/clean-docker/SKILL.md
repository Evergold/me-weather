---
name: clean-docker
description: Cleans unused Docker caches, temporary files, and snapshots to free up space while preserving the local ScyllaDB testing environment.
---

# clean-docker

This skill is designed to reclaim disk space from Docker's overlay caches, dangling images, and stopped containers, without destroying the images or volumes necessary to run ScyllaDB for local integration tests.

## Usage

When the user asks to clean docker, run the following steps using terminal commands:

1. **Clean Dangling Images and Stopped Containers:**
   Run the standard docker prune command to remove stopped containers, dangling images, and build caches.
   ```bash
   docker system prune -f
   ```
   *Note: Do NOT use the `-a` (all) flag, as that will remove the `scylladb/scylla` image if it is not currently running, forcing a massive re-download during the next test run.*

2. **Clean Docker Volumes (Carefully!):**
   If you need to prune volumes to save space, ensure no ScyllaDB data volumes are unintentionally wiped if the user intends to keep them. Usually, `testcontainers` cleans up its own volumes, but you can prune dangling volumes:
   ```bash
   docker volume prune -f
   ```

3. **Verify ScyllaDB Image Remains:**
   Verify that the `scylladb/scylla:2025.1.0` image is still available locally so the integration tests do not have to pull it again:
   ```bash
   docker images | grep scylla
   ```

## ScyllaDB Snapshots Note
Docker also uses "snapshots" in its overlay2 storage driver (which `docker system prune` cleans). However, if the user asks about **ScyllaDB Snapshots** specifically (which are SSTable backups created by `nodetool snapshot` or auto-snapshots before dropping/truncating tables), those are stored *inside* the container's `/var/lib/scylla/data/` directory.

To clean ScyllaDB internal snapshots inside a running container, use:
```bash
docker exec <container_id> nodetool clearsnapshot
```
