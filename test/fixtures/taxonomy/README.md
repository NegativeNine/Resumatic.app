# Taxonomy test files

These files are synthetic. They are written in the layouts ESCO and O*NET publish, so the builder
and the lookup can be tested, and they are not ESCO or O*NET data: the IDs are made up, the
occupation codes are in a range O*NET does not use, and the labels were written for these tests.

- `esco/` follows the ESCO classification CSV package for one language (`<file>_en.csv`).
- `onet/` follows the O*NET 30.3 and later CSV release.
- `crosswalk.csv` follows the O*NET - ESCO occupations crosswalk.

Some rows are wrong on purpose (an unknown occupation, a relation to a concept that isn't there),
so the tests can check that the builder sets them aside and says so.
