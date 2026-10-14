"""Regenerates oracle-models.json from scikit-learn (run: python3 tests/fixtures/make-oracle.py).

The JS tests compare src/models.ts against these reference outputs so the
implementations are checked against an independent library, not against
themselves. Pinned versions used to create the committed file are recorded in
the "versions" field.
"""
import json, pathlib
import numpy as np, sklearn
from sklearn.linear_model import Ridge, LogisticRegression
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score

rng = np.random.default_rng(7)
out = {"versions": {"numpy": np.__version__, "sklearn": sklearn.__version__}}

# ---- Ridge ----
X = rng.normal(size=(40, 4)); X[:, 3] = X[:, 0] * 0.8 + rng.normal(scale=0.3, size=40)   # correlated column
y = 3.0 * X[:, 0] - 2.0 * X[:, 1] + 0.5 * X[:, 2] + 4.0 + rng.normal(scale=0.5, size=40)
Xn = rng.normal(size=(6, 4))
out["ridge"] = []
for alpha in (1.0, 0.01, 25.0):
    m = Ridge(alpha=alpha).fit(X, y)
    out["ridge"].append(dict(alpha=alpha, X=X.tolist(), y=y.tolist(), Xnew=Xn.tolist(),
        coef=m.coef_.tolist(), intercept=float(m.intercept_), pred=m.predict(Xn).tolist()))

# ---- Logistic: 3 classes ----
centers = np.array([[0, 0, 0], [2.0, 1.0, -1.0], [-1.5, 2.5, 1.0]])
Xc = np.vstack([rng.normal(centers[k], 1.1, size=(30, 3)) for k in range(3)])
yc = np.repeat([0, 1, 2], 30)
Xcn = rng.normal(scale=1.8, size=(8, 3))
sc = StandardScaler().fit(Xc)
out["logistic_multi"] = []
for C in (1.0, 0.1):
    m = LogisticRegression(C=C, tol=1e-12, max_iter=20000).fit(sc.transform(Xc), yc)
    out["logistic_multi"].append(dict(C=C, X=sc.transform(Xc).tolist(), y=yc.tolist(), Xnew=sc.transform(Xcn).tolist(),
        proba=m.predict_proba(sc.transform(Xcn)).tolist(), pred=m.predict(sc.transform(Xcn)).tolist()))

# ---- Logistic: binary (overlapping classes so the penalty matters) ----
Xb = np.vstack([rng.normal([0, 0], 1.3, size=(35, 2)), rng.normal([1.2, 1.0], 1.3, size=(35, 2))])
yb = np.repeat([0, 1], 35)
Xbn = rng.normal(scale=1.5, size=(8, 2))
scb = StandardScaler().fit(Xb)
out["logistic_binary"] = []
for C in (1.0, 0.3, 10.0):
    m = LogisticRegression(C=C, tol=1e-12, max_iter=20000).fit(scb.transform(Xb), yb)
    out["logistic_binary"].append(dict(C=C, X=scb.transform(Xb).tolist(), y=yb.tolist(), Xnew=scb.transform(Xbn).tolist(),
        proba=m.predict_proba(scb.transform(Xbn)).tolist(), pred=m.predict(scb.transform(Xbn)).tolist()))

# ---- Trees (continuous data: no tied split gains) ----
Xt = rng.normal(size=(80, 3))
yt_c = ((Xt[:, 0] > 0.2) ^ (Xt[:, 1] > -0.3)).astype(int); flip = rng.random(80) < 0.08; yt_c = np.where(flip, 1 - yt_c, yt_c)
yt_r = np.where(Xt[:, 0] > 0, 5 + 2 * Xt[:, 1], -3 + Xt[:, 2]) + rng.normal(scale=0.3, size=80)
Xtn = rng.normal(size=(200, 3))
out["tree"] = []
for depth, leaf in ((3, 2), (5, 3), (2, 2)):
    tc = DecisionTreeClassifier(max_depth=depth, min_samples_leaf=leaf, random_state=0).fit(Xt, yt_c)
    tr = DecisionTreeRegressor(max_depth=depth, min_samples_leaf=leaf, random_state=0).fit(Xt, yt_r)
    out["tree"].append(dict(depth=depth, leaf=leaf, X=Xt.tolist(), y_class=yt_c.tolist(), y_reg=yt_r.tolist(), Xnew=Xtn.tolist(),
        class_pred=tc.predict(Xtn).tolist(), reg_pred=tr.predict(Xtn).tolist(),
        class_nodes=int(tc.tree_.node_count), reg_nodes=int(tr.tree_.node_count)))


# ---- k-means: well-separated blobs on very different scales (tests standardization) ----
blobs = np.vstack([rng.normal([0, 0], 0.5, size=(40, 2)), rng.normal([4, 5], 0.5, size=(40, 2)), rng.normal([-3, 6], 0.5, size=(40, 2))])
blobs[:, 1] *= 100.0
Z = StandardScaler().fit_transform(blobs)
km = KMeans(n_clusters=3, n_init=30, random_state=0).fit(Z)
out["kmeans_blobs"] = dict(X=blobs.tolist(), inertia=float(km.inertia_), labels=km.labels_.tolist(),
    silhouette=float(silhouette_score(Z, km.labels_)), sizes=np.bincount(km.labels_).tolist())

# ---- k-means: overlapping groups (several local optima) ----
over = np.vstack([rng.normal([0, 0], 1.0, size=(60, 2)), rng.normal([2, 1], 1.0, size=(60, 2)), rng.normal([1, 3], 1.0, size=(60, 2))])
Zo = StandardScaler().fit_transform(over)
out["kmeans_overlap"] = dict(X=over.tolist(), per_k={})
for k in (2, 3, 4, 5):
    m = KMeans(n_clusters=k, n_init=50, random_state=0).fit(Zo)
    out["kmeans_overlap"]["per_k"][str(k)] = dict(inertia=float(m.inertia_), silhouette=float(silhouette_score(Zo, m.labels_)))

pathlib.Path(__file__).with_name("oracle-models.json").write_text(json.dumps(out))
print("wrote", len(json.dumps(out)), "bytes;", out["versions"])
