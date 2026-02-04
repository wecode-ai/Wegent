# Database Migrations Guide

This guide covers database migration management using Alembic for the Wegent Backend application.

## Overview

Alembic is a database migration tool for SQLAlchemy. It provides version control for your database schema, allowing you to track changes, apply upgrades, and rollback if needed.

## Quick Start

### View Current Migration Status

```bash
# Check current database revision
alembic current

# View migration history
alembic history --verbose
```

### Apply Migrations

```bash
# Upgrade to the latest version
alembic upgrade head

# Upgrade by one version
alembic upgrade +1

# Upgrade to a specific revision
alembic upgrade <revision_id>
```

### Rollback Migrations

```bash
# Downgrade by one version
alembic downgrade -1

# Downgrade to a specific revision
alembic downgrade <revision_id>

# Downgrade to base (remove all migrations)
alembic downgrade base
```

### Create New Migrations

```bash
# Auto-generate a migration script based on model changes
alembic revision --autogenerate -m "description of changes"

# Create an empty migration script
alembic revision -m "description of changes"
```

After generating a migration script, always review it before applying to ensure it does what you expect.

## Important Notes

### Development vs Production

- **Development Mode**: Migrations run automatically on application startup when `ENVIRONMENT=development` and `DB_AUTO_MIGRATE=True`
- **Production Mode**: Migrations must be run manually. The application will log a warning if there are pending migrations.

### Best Practices

1. **Always review auto-generated migrations** - Alembic may not detect all changes correctly
2. **Test migrations on a copy of production data** before applying to production
3. **Backup your database** before running migrations in production
4. **Never edit applied migrations** - create a new migration instead
5. **Keep migrations small and focused** - easier to review and rollback if needed

### Migration Safety

- Initial migration uses `CREATE TABLE IF NOT EXISTS` to safely handle existing databases
- All migrations include both `upgrade()` and `downgrade()` functions for rollback support
- Foreign key constraints are properly handled in the correct order

## Common Commands

```bash
# Navigate to backend directory first
cd /path/to/wegent/backend

# Check what migrations will be applied
alembic upgrade head --sql

# Show the diff between database and models
alembic upgrade head --sql > migration.sql

# Get help
alembic --help
alembic upgrade --help
```

## Troubleshooting

### Migration Fails

1. Check database connection in `alembic.ini` or `DATABASE_URL` environment variable
2. Review the migration script for errors
3. Check database logs for detailed error messages

### Conflict with Existing Tables

If you have an existing database:
1. The initial migration is designed to be safe with `CREATE TABLE IF NOT EXISTS`
2. Run `alembic stamp head` to mark the database as up-to-date without running migrations
3. Future migrations will then apply normally

### Reset Migrations

**WARNING**: This will drop all tables and data!

```bash
# Downgrade to base
alembic downgrade base

# Upgrade to latest
alembic upgrade head
```

## Migration File Structure

```
backend/alembic/
├── versions/           # Migration scripts (never edit after applying)
│   ├── 0c086b93f8b9_initial_migration.py
│   └── b2c3d4e5f6a7_add_role_to_users.py  # User role migration
├── env.py             # Alembic runtime environment
├── script.py.mako     # Template for new migrations
└── README             # Quick reference
```

## Notable Migrations

### User Role Migration (`b2c3d4e5f6a7`)

This migration adds the `role` column to the `users` table for role-based access control:

- **Column**: `role` (VARCHAR(20), NOT NULL, default: 'user')
- **Values**: 'admin' or 'user'
- **Auto-upgrade**: Users with `user_name='admin'` are automatically set to `role='admin'`

The migration uses conditional SQL to safely handle cases where the column already exists.

## Workflow Example

Here's a typical workflow for adding a new model field:

1. **Modify the model** in `backend/app/models/`:
   ```python
   # Add new field to model
   class User(Base):
       # ... existing fields ...
       new_field = Column(String(100), nullable=True)
   ```

2. **Generate migration**:
   ```bash
   cd backend
   alembic revision --autogenerate -m "add new_field to user table"
   ```

3. **Review the generated migration** in `backend/alembic/versions/`:
   - Check that the changes match your expectations
   - Verify data type conversions
   - Ensure nullable/default values are correct

4. **Test the migration**:
   ```bash
   # Apply migration
   alembic upgrade head
   
   # Verify it works
   # Test your application
   
   # If needed, rollback
   alembic downgrade -1
   ```

5. **Commit the migration**:
   ```bash
   git add backend/alembic/versions/<new_migration>.py
   git commit -m "feat(backend): add new_field to user table"
   ```

## For More Information

- [Alembic Documentation](https://alembic.sqlalchemy.org/)
- [SQLAlchemy Documentation](https://docs.sqlalchemy.org/)
- [AGENTS.md - Backend Section](../../../../AGENTS.md#backend)