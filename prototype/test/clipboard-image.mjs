export const samplePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGPUqihkYGBgYGBgYoABABNLAReRfidRAAAAAElFTkSuQmCC',
  'base64',
);

export async function pasteNativeImage(app, composer) {
  await composer.focus();
  await app.evaluate(({ BrowserWindow, clipboard, nativeImage }, bytes) => {
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (image.isEmpty()) throw new Error('The test PNG could not be decoded.');
    clipboard.writeImage(image);
    BrowserWindow.getAllWindows()[0].webContents.paste();
  }, [...samplePng]);
}
