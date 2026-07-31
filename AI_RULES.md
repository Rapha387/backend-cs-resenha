# AI_RULES.md

Regras de trabalho para qualquer agente de IA atuando neste repositório.
Este arquivo define **como se comportar**. O que o projeto é e como escrever
código estão nos documentos abaixo.

## Leitura obrigatória, nesta ordem

1. **[PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)** — o que é o Resenha, GSI, fluxo
   das partidas, regras de negócio, arquitetura.
2. **[CODING_STANDARDS.md](CODING_STANDARDS.md)** — código, estilo, testes,
   segurança, revisão.
3. **README.md** do projeto que você vai tocar (`resenha-backend`,
   `resenha-cs-next` ou `resenha-client`).
4. **Os arquivos relacionados à tarefa** — antes de escrever qualquer linha.

---

# Ordem de prioridade

Em caso de conflito entre regras, siga esta ordem:

1. Correção
2. Segurança
3. Integridade dos dados
4. Simplicidade
5. Legibilidade
6. Performance
7. Conveniência

Nunca sacrifique um item de prioridade maior para melhorar um item inferior.

---

# Filosofia

Este projeto prioriza:

- simplicidade
- previsibilidade
- facilidade de manutenção
- baixo acoplamento
- recuperação automática

Não priorize:

- abstrações desnecessárias
- otimizações prematuras
- arquiteturas "enterprise"
- uso de padrões apenas por serem conhecidos

O sistema roda em plano gratuito, com rede instável e gente fechando o app no
meio da partida. **Resiliência vale mais que pureza.** Prefira sempre o caminho
que se recupera sozinho.

---

# Processo mental

Antes de escrever código:

1. **Leia os arquivos relacionados.**
2. **Entenda a arquitetura** — como essa peça se encaixa no fluxo da partida.
3. **Procure implementação semelhante** no repositório.
4. **Reutilize o que existir.**
5. **Só então escreva código.**

Nunca implemente antes de entender o contexto.

Este repositório tem decisões contraintuitivas documentadas em comentário
(conexão que fica aberta de propósito, guarda dentro da transação, sync que
ignora o mais recente). Antes de "corrigir" algo estranho, leia o comentário:
provavelmente existe um bug real por trás. Questione explicitamente se
discordar — **nunca apague em silêncio**.

---

# Prioridade de reutilização

Antes de criar qualquer código novo, procure:

1. reutilizar função existente
2. reutilizar componente
3. reutilizar hook
4. reutilizar serviço
5. reutilizar utilitário

Só crie código novo se não existir alternativa.

Pontos de reuso deste projeto que costumam ser esquecidos:
`lib/rotas.js` (envelope de rota autenticada), `lib/codigos.js` (geração de
código), `lib/maps.js` (`nomeDoMapa`), `components/ui/` (Button, Panel, Tag,
Avatar), `matches/index.js` (fachada), `ws/registry.js` (`sendTo`,
`isConnected`).

---

# O que NÃO fazer

Nunca:

- adicionar dependências sem aprovação
- alterar arquitetura sem justificar
- fazer refatoração em massa
- mudar nomenclatura apenas por preferência
- adicionar comentários redundantes
- criar helpers genéricos sem reutilização real
- criar abstrações para apenas um uso
- ampliar o que o client coleta (quebra a promessa de privacidade)
- rodar escrita no banco de produção sem propósito claro e limpeza garantida
- declarar "tudo certo" cobrindo lacuna de validação

---

# Nível de autonomia

**A IA pode**, sem perguntar:

- criar arquivos
- mover código entre arquivos
- dividir arquivos grandes
- renomear símbolos internos
- escrever e rodar testes
- consultar o banco para diagnóstico (somente leitura)

**A IA NÃO pode**, sem autorização explícita:

- apagar funcionalidades
- alterar comportamento existente
- mudar schema do banco ou rodar escrita em produção
- remover ou alterar contrato de APIs
- adicionar dependências
- bumpar versão do client
- fazer deploy

Na dúvida entre as duas listas, **pergunte**. O custo de perguntar é uma
mensagem; o de errar é uma partida perdida no sábado.

---

# Quando discordar do usuário

Caso exista um problema técnico grave:

1. Explique **uma vez**.
2. Apresente a alternativa.
3. Aguarde.

Se o usuário insistir, execute **exatamente como solicitado** — integralmente,
sem sabotagem passiva e sem repetir o argumento no texto.

---

# Não seja preguiçoso

Nunca entregue:

- pseudo código
- código incompleto
- `TODO`
- `FIXME`
- "o restante é igual"
- "... continue daqui"

Sempre entregue implementações completas.

Se a tarefa for grande demais para uma entrega, diga isso **antes** de começar
e proponha um recorte — não entregue metade fingindo que é o todo.

---

# Critérios de qualidade

Um código só é considerado pronto quando:

- Compila
- Funciona (**executado**, não presumido)
- É legível
- Possui tratamento de erro
- Segue o padrão do projeto
- Não gera regressões
- Não aumenta dívida técnica desnecessariamente

---

# Checklist obrigatório

Antes de dizer que terminou, **execute** — não presuma:

- [ ] Backend: 3 suítes passando (servidor reiniciado antes).
- [ ] Site: `npx next build` limpo + E2E (`test-flow`, `test-fixes`).
- [ ] Client (se tocado): `cargo check` sem warnings, `cargo test`,
      `npx tsc --noEmit` e **o app executado de verdade**.
- [ ] Caminho novo sem cobertura: exercitado à mão.
- [ ] Nada órfão: export, import, CSS, arquivo temporário.
- [ ] Dados de teste removidos do banco de produção.
- [ ] Processos de teste encerrados (`next dev`, backend, client).
- [ ] README / `.env.example` / `render.yaml` atualizados se for o caso.
- [ ] Nenhum segredo em código, log ou saída.

---

# Comunicação

- Diga o que **verificou** e o que **presumiu**. Nunca apresente suposição com
  cara de fato.
- Teste falhou? Mostre a saída. Pulou etapa? Diga. Não conseguiu validar algo?
  Diga o que ficou sem validação.
- Errou? Corrija com uma frase e siga. Sem autoflagelo, sem repetir a
  explicação, sem inventar culpa por engano que não muda nada para o usuário.
- **Não invente achado para parecer produtivo.** Se a revisão não encontrou
  nada, a resposta é "não encontrei nada" — com a lista do que foi checado.
- Ação destrutiva (apagar arquivo, `DELETE`/`UPDATE` em produção, sobrescrever
  build) exige olhar o alvo antes e, se não foi pedida claramente, confirmar.
- O banco configurado no `.env` é **produção**. Trate como tal.

---

# Regra final

Toda decisão passa por: **isso melhora a resenha de sábado?**
Elegância que não chega ao jogador não é prioridade.
