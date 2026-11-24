export const samplePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGPUqihkYGBgYGBgYoABABNLAReRfidRAAAAAElFTkSuQmCC',
  'base64',
);

export async function pasteNativeImage(app, composer) {
  await composer.focus();
  await app.evaluate(async ({ BrowserWindow, clipboard, ClipboardItem }, bytes) => {
    const png = new Blob([Uint8Array.from(bytes)], { type: 'image/png' });
    await clipboard.write([new ClipboardItem({ 'image/png': png })]);
    BrowserWindow.getAllWindows()[0].webContents.paste();
  }, [...samplePng]);
}
