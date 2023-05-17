#! /usr/bin/env node

import argon2 from 'argon2'
import { program } from 'commander'
import inquirer from 'inquirer'

import CodeLab from './codelab.js'

function codeLab(args) {
  return (new CodeLab(args))
    .on('begin', ({ name }) =>
      process.stdout.write(`${
        new Intl.DateTimeFormat(undefined, {
          hourCycle: 'h24',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          fractionalSecondDigits: 3
        }).format(new Date())
      }  ${name.padEnd(26)}`)
    )
    .on('success', () => process.stdout.write('✅\n'))
}

try {
  program
    .command('down')
    .description('tear an environment down')
    .option('-e, --env <env>', 'environment', 'codelab')
    .action(async ({ env }) => {
      await codeLab({ env }).tearDown()
    })

  program
    .command('up')
    .description('set an environment up')
    .argument('<repo>')
    .option('-e, --env <env>', 'environment', 'codelab')
    .option('-i, --infra <infra>', 'infrastructure', 'aws-ecs')
    .action(async (repo, { env, infra }) => {
      const publicUrl = await codeLab({ env }).setUp({
        infra,
        repo,
        passwordHash: await argon2.hash(
          // TODO: don't ask for password if already configured
          (await inquirer.prompt([{
            type: 'password',
            name: 'password',
            message: 'Password:',
            mask: '*'
          }])).password,
          { type: argon2.argon2i }
        )
      })
      console.log(publicUrl)
    })
  
  await program.parseAsync()
} catch (error) {
  console.error('error:', error)
  process.exitCode = 1
}
