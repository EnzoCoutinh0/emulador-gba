import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome')
        ctx = await b.new_context(accept_downloads=True); page = await ctx.new_page()
        errs=[]; page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('file://dist/Emulador-GBA.html')
        await page.set_input_files('#romInput', 'test/build/flash_thumb.gba'); await page.wait_for_timeout(1500)
        async with page.expect_download() as d: await page.click('#btnExport')
        dl = await d.value; path = await dl.path()
        import os; print('download:', dl.suggested_filename, os.path.getsize(path), 'errs', errs)
        await b.close()
asyncio.run(main())
