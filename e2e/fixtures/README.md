Test fixtures.

- `coco-036.jpg`, `coco-049.jpg`, `coco-061.jpg`: images from the COCO dataset
  (cocodataset.org, CC BY 4.0; original images under their Flickr licences),
  via the COCO8 sample set.
- `python-reference.json`: what the exported detector finds in those images
  when run from Python (onnxruntime, PIL letterbox). The browser must agree.
- `camera.y4m`: coco-036 as one raw video frame, fed to Chromium as a fake
  camera so the live-camera path can be tested headless.
