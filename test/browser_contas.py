# Testa contas, biblioteca e "continuar de onde parou" no Chrome
import asyncio, os
from playwright.async_api import async_playwright
URL = 'file://' + os.path.abspath('index.html')
ASTRO = os.path.abspath('exemplos/astro-defensor/astro-defensor.gba')
PPU = os.path.abspath('test/build/ppu_thumb.gba')
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        ctx = await b.new_context(viewport={'width': 1400, 'height': 900})
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        T = lambda: page.inner_text('#toast')
        await page.goto(URL); await page.wait_for_timeout(600)
        print('1. tela inicial:', await page.evaluate("document.body.className"))
        await page.screenshot(path='/tmp/shots/1_login.png')
        # criar conta
        await page.fill('#nuUser', 'Enzo'); await page.fill('#nuPass', '1234'); await page.fill('#nuPass2', '1234')
        await page.click('#formNew button[type=submit]'); await page.wait_for_timeout(1500)
        print('2. após criar conta:', await page.evaluate("document.body.className"), '|', await page.inner_text('#libHello'))
        # adicionar jogo 1 e jogar
        await page.set_input_files('#romInput', ASTRO); await page.wait_for_timeout(1500)
        print('3. abriu jogo:', await T())
        await page.keyboard.press('Enter'); await page.wait_for_timeout(400)
        await page.keyboard.down('KeyX'); await page.keyboard.down('ArrowUp'); await page.wait_for_timeout(2500)
        await page.keyboard.up('ArrowUp'); await page.keyboard.up('KeyX')
        # salvar no espaço 2
        await page.click('#btnSaveState'); await page.wait_for_timeout(500)
        await page.click('#slotList .slot:nth-child(3) button:has-text("Salvar aqui")'); await page.wait_for_timeout(800)
        print('4. estado espaço 2:', await T())
        await page.screenshot(path='/tmp/shots/4_states.png')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(200)
        await page.locator('#screen').screenshot(path='/tmp/shots/4_antes_de_sair.png')
        # ir para a biblioteca (grava o automático)
        await page.click('#btnLibrary'); await page.wait_for_timeout(1500)
        # adicionar jogo 2
        await page.set_input_files('#romInput', PPU); await page.wait_for_timeout(1500)
        await page.click('#btnLibrary'); await page.wait_for_timeout(1500)
        print('5. biblioteca:', await page.locator('#libGrid .card').count(), 'jogos:', await page.locator('#libGrid .card b').all_inner_texts())
        await page.screenshot(path='/tmp/shots/5_biblioteca.png')
        # voltar ao Astro: deve continuar de onde parou
        await page.click('#libGrid .card:has-text("ASTRODEFENS") .cover'); await page.wait_for_timeout(1200)
        print('6. retomou:', await T())
        await page.locator('#screen').screenshot(path='/tmp/shots/6_retomado.png')
        # trocar de conta: Maria não vê os jogos do Enzo
        await page.click('#acctBtn'); await page.click('#amSwitch'); await page.wait_for_timeout(800)
        await page.click('.ltab[data-lt=new]')
        await page.fill('#nuUser', 'Maria'); await page.fill('#nuPass', 'abcd'); await page.fill('#nuPass2', 'abcd')
        await page.click('#formNew button[type=submit]'); await page.wait_for_timeout(1200)
        print('7. Maria:', await page.inner_text('#libHello'), '| jogos:', await page.locator('#libGrid .card').count())
        # recarregar: sessão lembrada
        await page.reload(); await page.wait_for_timeout(1500)
        print('8. após recarregar:', await page.evaluate("document.body.className"), '|', await page.inner_text('#libHello'))
        # sair e entrar como Enzo com senha errada e depois certa
        await page.click('#acctBtn'); await page.click('#amOut'); await page.wait_for_timeout(800)
        print('9. contas listadas:', await page.locator('#acctList .acct').all_inner_texts())
        await page.click('#acctList .acct:has-text("Enzo")')
        await page.fill('#liPass', 'errada'); await page.click('#formIn button[type=submit]'); await page.wait_for_timeout(1200)
        print('10. senha errada:', await page.inner_text('#loginErr'))
        await page.fill('#liPass', '1234'); await page.click('#formIn button[type=submit]'); await page.wait_for_timeout(1500)
        print('11. Enzo de volta:', await page.inner_text('#libHello'), '| jogos:', await page.locator('#libGrid .card b').all_inner_texts())
        print('    subtítulos:', await page.locator('#libGrid .card .muted').all_inner_texts())
        await page.click('#libGrid .card:has-text("ASTRODEFENS") .cover'); await page.wait_for_timeout(1200)
        print('12. retomou depois de recarregar a página:', await T())
        await page.click('#btnSaveState'); await page.wait_for_timeout(600)
        print('13. espaços:', await page.locator('#slotList .slot .muted').all_inner_texts())
        print('erros:', [e for e in errs if 'GL Driver' not in e])
        await b.close()
asyncio.run(main())
