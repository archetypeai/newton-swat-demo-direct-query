# SWaT data prep scripts

Ported from [`archetypeai/archetypeai-batch-examples-swat/1_prepare_data`](https://github.com/archetypeai/archetypeai-batch-examples-swat/tree/main/1_prepare_data).

Only needed if you want to rebuild the pre-processed CSVs in `data/` from a raw [Kaggle](https://www.kaggle.com/datasets/vishala28/swat-dataset-secure-water-treatment-system) download.

| Script | Purpose |
| --- | --- |
| `convert_swat_data.py` | Merge normal + attack CSVs, forward-fill missing SCADA values, drop 11 constant-value actuators, write `swat_raw_labeled.csv` |
| `generate_labels.py` | Split the labeled timeline into n-shot training files (`swat_normal.csv`, `swat_attack.csv`) and inference/smoke-test subsets |

Usage:

```bash
# Place SWaT_Dataset_Normal_v1.csv and SWaT_Dataset_Attack_v0.csv in data/
python scripts/convert_swat_data.py
python scripts/generate_labels.py
```

## Attribution

The SWaT dataset is the work of [iTrust, Centre for Research in Cyber Security](https://itrust.sutd.edu.sg/) at Singapore University of Technology and Design. Request the dataset through iTrust for published work.
