import {
  IAM,
  EntityAlreadyExistsException,
  LimitExceededException,
  NoSuchEntityException
} from '@aws-sdk/client-iam'

import {
  EC2,
  EC2ServiceException,
  waitUntilInstanceRunning,
  waitUntilInstanceTerminated
} from '@aws-sdk/client-ec2'

import { SSM, waitUntilCommandExecuted } from '@aws-sdk/client-ssm'

import { createWaiter, WaiterState } from '@aws-sdk/util-waiter'

import axios from 'axios'
import EventEmitter from 'events'

const APP_NAME = 'codelab'

export default class extends EventEmitter {
  #iam
  #ec2
  #ssm
  #env
  #roleName
  #policyName
  #profileName
  #secGroupName
  #instanceName
  
  constructor({ env }) {
    super()
    this.#iam = new IAM()
    this.#ec2 = new EC2()
    this.#ssm = new SSM()
    this.#env = env
    this.#roleName = `${APP_NAME}-${env}-role`
    this.#policyName =  `${APP_NAME}-${env}-policy`
    this.#profileName = `${APP_NAME}-${env}-profile`
    this.#secGroupName = `${APP_NAME}-${env}-security-group`
    this.#instanceName = `${APP_NAME}-${env}-instance`
  }

  async #task(name, promise) {
    this.emit('begin', { name })
    const output = await promise
    this.emit('success')
    return output
  }
  
  async #iamDeleteTask(name, promise) {
    this.emit('begin', { name })
    try {
      await promise
    } catch (error) {
      if (!(error instanceof NoSuchEntityException)) {
        throw error
      }
    }
    this.emit('success')
  }

  async #ssmCommandTask(name, InstanceId, commands) {
    this.emit('begin', { name })
    const { Command: { CommandId } } = await this.#ssm.sendCommand({
      InstanceIds: [InstanceId],
      DocumentName: 'AWS-RunShellScript',
      Parameters: { commands }
    })
    const {
      reason: { StandardOutputContent }
    } = await waitUntilCommandExecuted(
      { client: this.#ssm },
      { CommandId, InstanceId }
    )
    this.emit('success')
    return StandardOutputContent
  }

  #waitTask(name, condition) {
    return this.#task(
      name,
      createWaiter({ maxDelay: 2 }, null, async () => {
        try {
          return { state: await condition() }
        } catch {
          return { state: WaiterState.RETRY }
        }
      })
    )
  }

  #tags(name) {
    return [{
        Key: 'Application',
        Value: APP_NAME
      }, {
        Key: 'Environment',
        Value: this.#env
      }, {
        Key: 'Name',
        Value: name
      }]
  }

  #tagSpecs(type, name) {
    return [{
      ResourceType: type,
      Tags: this.#tags(name)
    }]
  }

  async #eligibleInstanceIds() {
    const { Reservations } = await this.#ec2.describeInstances({
      Filters: [{
        Name: 'tag:Name',
        Values: [this.#instanceName]
      }]
    })
    // there should only be at most one instance, but just in case
    return Reservations.flatMap(({ Instances }) =>
      Instances
        // skip already terminated instances
        .filter(({ State: { Code } }) => Code !== 48)
        .map(({ InstanceId }) => InstanceId)
    )
  }

  async tearDown() {
    this.emit('begin', { name: 'Terminate instances' })
    const InstanceIds = await this.#eligibleInstanceIds()
    if (InstanceIds.length > 0) {
      await this.#ec2.terminateInstances({ InstanceIds })
    }
    this.emit('success')

    if (InstanceIds.length > 0) {
      await this.#task(
        'Wait until terminated',
        waitUntilInstanceTerminated(
          { client: this.#ec2 },
          { InstanceIds }
        )
      )
    }

    this.emit('begin', { name: 'Delete security group' })
    try {
      await this.#ec2.deleteSecurityGroup({ GroupName: this.#secGroupName })
    } catch (error) {
      if (!(error instanceof EC2ServiceException && error.Code === 'InvalidGroup.NotFound')) {
        throw error
      }
    }
    this.emit('success')

    const InstanceProfileName = this.#profileName
    const PolicyName = this.#policyName
    const RoleName = this.#roleName

    await this.#iamDeleteTask(
      'Remove role from profile',
      this.#iam.removeRoleFromInstanceProfile({ InstanceProfileName, RoleName })
    )

    await this.#iamDeleteTask(
      'Delete profile',
      this.#iam.deleteInstanceProfile({ InstanceProfileName })
    )

    await this.#iamDeleteTask(
      'Remove policy from role',
      this.#iam.deleteRolePolicy({ RoleName, PolicyName })
    )

    await this.#iamDeleteTask(
      'Delete role',
      this.#iam.deleteRole({ RoleName })
    )
  }

  async setUp({ repo, passwordHash }) {
    const serverPort = 8080
    const proxyHttpPort = 80
    const proxyHttpsPort = 443

    const RoleName = this.#roleName
    const AssumeRolePolicyDocument = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Action: 'sts:AssumeRole',
        Principal: { Service: 'ec2.amazonaws.com' }
      }]
    })

    this.emit('begin', { name: 'Create role' })
    try {
      await this.#iam.updateAssumeRolePolicy({ RoleName, PolicyDocument: AssumeRolePolicyDocument })
    } catch (error) {
      if (!(error instanceof NoSuchEntityException)) {
        throw error
      }
      await this.#iam.createRole({
        Tags: this.#tags(RoleName),
        RoleName,
        AssumeRolePolicyDocument
      })
    }
    this.emit('success')

    await this.#task(
      'Add policy to role',
      this.#iam.putRolePolicy({
        RoleName,
        PolicyName: this.#policyName,
        PolicyDocument: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Action: '*',
            Resource: '*'
          }]
        })
      })
    )

    const InstanceProfileName = this.#profileName

    this.emit('begin', { name: 'Create profile' })
    try {
      await this.#iam.createInstanceProfile({
        Tags: this.#tags(InstanceProfileName),
        InstanceProfileName
      })
    } catch (error) {
      if (!(error instanceof EntityAlreadyExistsException)) {
        throw error
      }
    }
    this.emit('success')

    this.emit('begin', { name: 'Add role to profile' })
    try {
      await this.#iam.addRoleToInstanceProfile({ InstanceProfileName, RoleName })
    } catch (error) {
      if (!(error instanceof LimitExceededException)) {
        throw error
      }
    }
    this.emit('success')

    const GroupName = this.#secGroupName
    let GroupId

    this.emit('begin', { name: 'Create security group' })
    const { SecurityGroups } = await this.#ec2.describeSecurityGroups({
      Filters: [{
        Name: 'group-name',
        Values: [GroupName]
      }]
    })
    if (SecurityGroups.length === 0) {
      GroupId = (await this.#ec2.createSecurityGroup({
        TagSpecifications: this.#tagSpecs('security-group', GroupName),
        GroupName,
        Description: GroupName
      })).GroupId
    } else {
      GroupId = SecurityGroups[0].GroupId
    }
    this.emit('success')

    this.emit('begin', { name: 'Allow ingress HTTP' })
    try {
      await this.#ec2.authorizeSecurityGroupIngress({
        GroupId,
        IpProtocol: 'tcp',
        CidrIp: '0.0.0.0/0',
        FromPort: proxyHttpPort,
        ToPort: proxyHttpPort
      })
    } catch (error) {
      if (!(error instanceof Error && error.Code === 'InvalidPermission.Duplicate')) {
        throw error
      }
    }
    this.emit('success')

    this.emit('begin', { name: 'Allow ingress HTTPS' })
    try {
      await this.#ec2.authorizeSecurityGroupIngress({
        GroupId,
        IpProtocol: 'tcp',
        CidrIp: '0.0.0.0/0',
        FromPort: proxyHttpsPort,
        ToPort: proxyHttpsPort
      })
    } catch (error) {
      if (!(error instanceof Error && error.Code === 'InvalidPermission.Duplicate')) {
        throw error
      }
    }
    this.emit('success')

    const DOCKER_PROXY_COMMAND = [
      'curl --location https://rpm.nodesource.com/setup_16.x | sh -',
      'yum install --assumeyes docker gcc-c++ git nodejs',
      'npm install --global @devcontainers/cli',
      'systemctl start docker',
      'if [ "$(docker info --format \'{{.Swarm.ControlAvailable}}\')" = "false" ];'
        + 'then docker swarm init; fi',
      `if [ "$(docker network ls --filter name=${APP_NAME}-net --format \'{{.}}\')" = "" ];`
        + `then docker network create --driver overlay ${APP_NAME}-net; fi`,
      // proxy needs to get cycled if already running since the DNS name may have changed
      'if [ "$(docker service ls --filter name=caddy --format \'{{.}}\')" != "" ];'
        + 'then docker service rm caddy; fi',
      'DIG_OUT=$(dig +short -x $(dig +short @resolver4.opendns.com myip.opendns.com))',
      `docker service create --detach --name caddy --network ${APP_NAME}-net`
        + ` --publish ${proxyHttpPort}:${proxyHttpPort} --publish ${proxyHttpsPort}:${proxyHttpsPort}`
        + ` caddy caddy reverse-proxy --from \${DIG_OUT::-1}:${proxyHttpsPort} --to code-server:${serverPort}`
    ].join(' && ')

    const DEVCONTAINER_COMMAND = [
      `aws configure set default.region ${process.env.AWS_REGION}`,
      'mkdir --parents /usr/share/codelab',
      'echo "aws ssm get-parameter --with-decryption --output text --name GIT_PASS --query Parameter.Value" > /usr/share/codelab/git-askpass.sh',
      // owner: rwx, group: r, others: r
      'chmod 0744 /usr/share/codelab/git-askpass.sh',
      'if [ ! -d /srv/workspace ];'
        + `then GIT_ASKPASS=/usr/share/codelab/git-askpass.sh git clone https://awkward-ninja@github.com/${repo}.git /srv/workspace; fi`,
      'curl --location --create-dirs --output /usr/share/codelab/install-code-server.sh https://code-server.dev/install.sh',
      // owner: rwx, group: rx, others: rx
      'chmod 0755 /usr/share/codelab/install-code-server.sh',
      'devcontainer build --image-name code-server --workspace-folder /srv/workspace',
      'chown --recursive $(docker run --rm code-server id --user) /srv/workspace',
      'if [ "$(docker service ls --filter name=code-server --format \'{{.}}\')" = "" ];'
        + 'then ' + [
          // TODO: find a more secure way to retrieve this value
          `echo '${passwordHash}' | docker secret create CODE_SERVER_HASHED_PASSWORD -`,
          'AWS_PARAMS=$(aws resourcegroupstaggingapi get-resources --output text --resource-type-filters ssm:parameter --tag-filters Key=codelab:env --query ResourceTagMappingList[].[ResourceARN])',
          'if [ "$AWS_PARAMS" != "" ];'
            + 'then echo "$AWS_PARAMS" | sed --regexp-extended \'s/^[^/]*\\/(_?)(.*)$/\\1\\2 \\2/\''
              + '| xargs --max-args=2 sh -c \'echo $(aws ssm get-parameter --with-decryption --output text --name $0 --query Parameter.Value) | docker secret create $1 -\''
            + '; fi',
          `docker service create --detach --name code-server --network ${APP_NAME}-net`
            + ' --secret CODE_SERVER_HASHED_PASSWORD'
            + ' $(echo "$AWS_PARAMS" | sed --regexp-extended \'s/^[^/]*\\/_?(.*)$/--secret \\1/\')'
            + ' --mount type=bind,source=/usr/share/codelab,destination=/mnt/codelab'
            + ' --mount type=bind,source=/srv,destination=/srv'
            + ' code-server sh -c "' + [
              '/mnt/codelab/install-code-server.sh --method=standalone',
              `HASHED_PASSWORD=\\$(cat /run/secrets/CODE_SERVER_HASHED_PASSWORD) ~/.local/bin/code-server --bind-addr 0.0.0.0:${serverPort} /srv/workspace`
            ].join(' && ') + '"'
        ].join(' && ') + '; fi'
        // TODO: at least update CODE_SERVER_HASHED_PASSWORD when service is already running
    ].join(' && ')

    let InstanceId

    this.emit('begin', { name: 'Run instance' })
    const InstanceIds = await this.#eligibleInstanceIds()
    if (InstanceIds.length === 0) {
      InstanceId = (await this.#ec2.runInstances({
        TagSpecifications: this.#tagSpecs('instance', this.#instanceName),
        MinCount: 1,
        MaxCount: 1,
        InstanceType: 't2.small',
        // Amazon Linux 2 Kernel 5.10
        ImageId: 'ami-06e85d4c3149db26a',
        SecurityGroupIds: [GroupId],
        UserData: btoa([
          '#! /bin/sh',
          DOCKER_PROXY_COMMAND,
          DEVCONTAINER_COMMAND
        ].join('\n'))
      })).Instances[0].InstanceId
    } else {
      InstanceId = InstanceIds[0]
      await this.#ec2.startInstances({ InstanceIds: [InstanceId] })
    }
    this.emit('success')

    const {
      reason: { Reservations: [{ Instances: [{ PublicDnsName }] }] }
    } = await this.#task(
      'Wait until running',
      waitUntilInstanceRunning(
        { client: this.#ec2 },
        { InstanceIds: [InstanceId] }
      )
    )

    this.emit('begin', { name: 'Add profile to instance' })
    try {
      await this.#ec2.associateIamInstanceProfile({
        InstanceId,
        IamInstanceProfile: { Name: InstanceProfileName }
      })
    } catch (error) {
      if (!(error instanceof Error && error.Code === 'IncorrectState')) {
        throw error
      }
    }
    this.emit('success')

    if (InstanceIds.length > 0) {
      await this.#waitTask(
        'Wait until managed',
        async () => {
          const { InstanceInformationList } = await this.#ssm.describeInstanceInformation({
            Filters: [{
              Key: 'InstanceIds',
              Values: [InstanceId]
            }]
          })
          return InstanceInformationList.length > 0 ? WaiterState.SUCCESS : WaiterState.RETRY
        }
      )

      await this.#ssmCommandTask('Provision instance', InstanceId, [DOCKER_PROXY_COMMAND, DEVCONTAINER_COMMAND])
    }
  
    const PublicUrl = `https://${PublicDnsName}`

    await this.#waitTask(
      'Wait until ready',
      async () => {
        const { status } = await axios.get(`${PublicUrl}/healthz`)
        return status === 200 ? WaiterState.SUCCESS : WaiterState.RETRY
      }
    )

    return PublicUrl
  }
}
