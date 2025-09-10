const uploadInput = document.getElementById('uploadImage');
const uploadBtn = document.getElementById('uploadBtn');
const gallery = document.getElementById('portfolio-gallery');

// Fonction pour afficher les images
function displayImages(urls) {
  gallery.innerHTML = '';
  urls.forEach(url => {
    const img = document.createElement('img');
    img.src = url;
    img.className = 'portfolio-img';
    gallery.appendChild(img);
  });
}

// Upload d’images
uploadBtn.addEventListener('click', () => {
  const files = uploadInput.files;
  if (files.length === 0) return alert("Choisis au moins une image.");

  const formData = new FormData();
  for (let i = 0; i < files.length; i++) formData.append('images', files[i]);

  fetch('/upload', { method: 'POST', body: formData })
    .then(res => res.json())
    .then(urls => displayImages(urls))
    .catch(err => console.error(err));
});
