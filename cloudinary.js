const { v2: cloudinary } = require("cloudinary");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function uploadImageToCloudinary(filePath) {
  const result = await cloudinary.uploader.upload(filePath, {
    resource_type: "image",
    folder: "archvideo"
  });

  return result.secure_url;
}

module.exports = {
  uploadImageToCloudinary
};
