-- Runs once on first Postgres init (fresh volume). The integration harness also
-- creates this DB defensively if the volume already existed, so both paths work.
CREATE DATABASE scheduler_test;
