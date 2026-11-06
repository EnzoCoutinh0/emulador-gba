import asyncio, sys
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        for name, vp, touch in [('desk', {'width': 1280, 'height': 800}, False), ('mobile', {'width': 390, 'height': 844}, True)]:
            ctx = await b.new_context(viewport=vp, has_touch=touch, is_mobile=touch)
            page = await ctx.new_page()
            errs = []
            page.on('pageerror', lambda e: errs.append(str(e)))
            page.on('console', lambda m: errs.append('console:' + m.text) if m.type in ('error', 'warning') else None)
            await page.goto('file://' + __import__('os').path.abspath('dist/index.html'))
            await page.wait_for_timeout(500)
            await page.screenshot(path=f'test/shot_{name}_empty.png')
            await page.set_input_files('#romInput', 'test/build/ppu_thumb.gba')
            await page.wait_for_timeout(2500)
            await page.keyboard.down('KeyX'); await page.wait_for_timeout(100); await page.keyboard.up('KeyX')
            await page.screenshot(path=f'test/shot_{name}_game.png')
            st = await page.inner_text('#status')
            print(name, 'status:', st, 'errs:', errs)
            await ctx.close()
        await b.close()
asyncio.run(main())
