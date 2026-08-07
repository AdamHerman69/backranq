-- PostgreSQL requires new enum labels to commit before a later transaction can
-- use them in constraints or data writes.
ALTER TYPE "CreditLedgerEntryType" ADD VALUE 'ALLOWANCE_GRANTED';
ALTER TYPE "CreditLedgerEntryType" ADD VALUE 'ALLOWANCE_EXPIRED';
