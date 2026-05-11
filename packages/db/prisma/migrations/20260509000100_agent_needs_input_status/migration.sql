DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'AgentRequestStatus'
      AND e.enumlabel = 'NEEDS_INPUT'
  ) THEN
    ALTER TYPE "AgentRequestStatus" ADD VALUE 'NEEDS_INPUT';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'AgentRunStatus'
      AND e.enumlabel = 'NEEDS_INPUT'
  ) THEN
    ALTER TYPE "AgentRunStatus" ADD VALUE 'NEEDS_INPUT';
  END IF;
END $$;

