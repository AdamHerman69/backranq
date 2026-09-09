-- T2 was added in the preceding migration, so its enum value is committed here.
ALTER TABLE "AnalysisRun"
    DROP CONSTRAINT "AnalysisRun_quality_credit_contract_check",
    ADD CONSTRAINT "AnalysisRun_quality_credit_contract_check"
        CHECK (
            ("executionMode" = 'SERVER_QUEUE'
                AND "analysisQuality" = 'STANDARD'
                AND "creditCost" = 7)
            OR
            ("executionMode" = 'SERVER_QUEUE'
                AND "analysisQuality" IN ('THOROUGH', 'T2')
                AND "creditCost" = 10)
            OR
            ("executionMode" <> 'SERVER_QUEUE' AND "creditCost" = 0)
        );
