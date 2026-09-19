const form = document.getElementById("grab-form");
const urlInput = document.getElementById("url-input");
const grabButton = document.getElementById("grab-button");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const imageGrid = document.getElementById("image-grid");
const imageCount = document.getElementById("image-count");
const logoSection = document.getElementById("logo-section");
const logoCard = document.getElementById("logo-card");
const downloadAllBtn = document.getElementById("download-all");

let lastResult = null;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  setStatus("Fetching page and analyzing images…", false);
  grabButton.disabled = true;
  resultsEl.classList.add("hidden");

  try {
    const response = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await response.json();

    if (!response.ok) {
      setStatus(data.error || "Something went wrong.", true);
      return;
    }

    lastResult = data;
    renderResults(data);

    if (data.warnings && data.warnings.length > 0) {
      setStatus(data.warnings.join(" "), false);
    } else {
      setStatus(`Found ${data.images.length} product image(s) and a logo.`, false);
    }
  } catch (err) {
    setStatus("Network error while contacting the server.", true);
  } finally {
    grabButton.disabled = false;
  }
});

downloadAllBtn.addEventListener("click", () => {
  if (!lastResult) return;
  const body = {
    images: lastResult.images.map((img) => img.url),
    logo: lastResult.logo ? lastResult.logo.url : null,
  };
  postAndDownload("/api/download-all", body, "soad-product-assets.zip");
});

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", Boolean(isError));
}

function renderResults(data) {
  resultsEl.classList.remove("hidden");
  imageCount.textContent = `(${data.images.length})`;
  imageGrid.innerHTML = "";

  if (data.images.length === 0) {
    imageGrid.innerHTML = '<p class="empty-state">No product images were found.</p>';
  } else {
    for (const [index, image] of data.images.entries()) {
      imageGrid.appendChild(buildAssetCard(image, `product-${index + 1}`));
    }
  }

  if (data.logo) {
    logoSection.classList.remove("hidden");
    logoCard.innerHTML = "";
    logoCard.appendChild(buildAssetCard(data.logo, "logo"));
  } else {
    logoSection.classList.add("hidden");
  }
}

function buildAssetCard(asset, baseName) {
  const card = document.createElement("div");
  card.className = "asset-card";

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  const img = document.createElement("img");
  img.src = asset.url;
  img.loading = "lazy";
  img.alt = baseName;
  thumb.appendChild(img);
  card.appendChild(thumb);

  const meta = document.createElement("div");
  meta.className = "asset-meta";
  const dims = asset.width && asset.height ? `${asset.width}×${asset.height}` : asset.width ? `${asset.width}px wide` : "Dimensions unknown";
  meta.innerHTML = `<span>${dims}</span><span>${(asset.format || "unknown").toUpperCase()}</span>`;
  card.appendChild(meta);

  const link = document.createElement("a");
  link.className = "download";
  link.textContent = "Download";
  link.href = downloadUrlFor(asset, baseName);
  card.appendChild(link);

  return card;
}

function downloadUrlFor(asset, baseName) {
  const filename = `${baseName}.${asset.format || "jpg"}`;
  return `/api/download?url=${encodeURIComponent(asset.url)}&filename=${encodeURIComponent(filename)}`;
}

async function postAndDownload(path, body, filename) {
  const originalLabel = downloadAllBtn.textContent;
  downloadAllBtn.disabled = true;
  downloadAllBtn.textContent = "Preparing zip…";
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setStatus(data.error || "Could not build the zip file.", true);
      return;
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (err) {
    setStatus("Network error while building the zip file.", true);
  } finally {
    downloadAllBtn.disabled = false;
    downloadAllBtn.textContent = originalLabel;
  }
}
