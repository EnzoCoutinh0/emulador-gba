import asyncio
from playwright.async_api import async_playwright
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=ARGS)
        for name, vp in [('retrato', {'width': 390, 'height': 844}), ('deitado', {'width': 844, 'height': 390})]:
            ctx = await b.new_context(viewport=vp, has_touch=True, is_mobile=True, device_scale_factor=3)
            page = await ctx.new_page(); errs = []
            page.on('pageerror', lambda e: errs.append(str(e)))
            await page.goto('file://' + __import__('os').path.abspath('dist/index.html'))
            await page.set_input_files('#romInput', 'test/build/ppu_thumb.gba'); await page.wait_for_timeout(1500)
            # toque no A e no meio de A/B
            box = await page.locator('.abzone .a').bounding_box()
            await page.dispatch_event('.abzone', 'pointerdown', {'pointerId': 7, 'clientX': box['x'] + box['width'] / 2, 'clientY': box['y'] + box['height'] / 2, 'isPrimary': True})
            await page.wait_for_timeout(50); k1 = await page.evaluate("window.__keys")
            await page.dispatch_event('.abzone', 'pointerup', {'pointerId': 7})
            dp = await page.locator('.dpad').bounding_box()
            await page.dispatch_event('.dpad', 'pointerdown', {'pointerId': 8, 'clientX': dp['x'] + dp['width'] * 0.9, 'clientY': dp['y'] + dp['height'] * 0.1})
            await page.wait_for_timeout(50); k2 = await page.evaluate("window.__keys")
            await page.screenshot(path=f'test/m_{name}.png')
            await page.dispatch_event('.dpad', 'pointerup', {'pointerId': 8})
            print(name, 'A:', hex(k1), 'dpad diagonal ↗:', hex(k2), 'saída', await page.evaluate("__emu.renderer.outW+'x'+__emu.renderer.outH"), 'erros', errs)
            await ctx.close()
        await b.close()
asyncio.run(main())
