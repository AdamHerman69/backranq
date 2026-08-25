ALTER TABLE "AnalyzedGame"
ADD COLUMN "plyCount" INTEGER;

UPDATE "AnalyzedGame" AS game
SET "plyCount" = counts."plyCount"
FROM (
    SELECT
        source."id",
        COUNT(*)::INTEGER AS "plyCount"
    FROM "AnalyzedGame" AS source
    CROSS JOIN LATERAL regexp_split_to_table(
        regexp_replace(
            regexp_replace(
                regexp_replace(
                    regexp_replace(source."pgn", '\[[^\]]*\]', ' ', 'g'),
                    '\{[^}]*\}',
                    ' ',
                    'g'
                ),
                '\([^)]*\)',
                ' ',
                'g'
            ),
            '\$[0-9]+',
            ' ',
            'g'
        ),
        '\s+'
    ) AS token("value")
    WHERE token."value" <> ''
      AND token."value" !~ '^[0-9]+\.(\.\.)?$'
      AND token."value" !~ '^(1-0|0-1|1/2-1/2|\*)$'
      AND token."value" <> '...'
    GROUP BY source."id"
) AS counts
WHERE game."id" = counts."id";

UPDATE "AnalyzedGame"
SET "plyCount" = 0
WHERE "plyCount" IS NULL;

ALTER TABLE "AnalyzedGame"
ALTER COLUMN "plyCount" SET NOT NULL;

ALTER TABLE "AnalyzedGame"
ADD CONSTRAINT "AnalyzedGame_plyCount_nonnegative"
CHECK ("plyCount" >= 0);
