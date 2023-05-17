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

import { ECR, RepositoryNotFoundException } from '@aws-sdk/client-ecr'

import {
  ECS,
  ClusterNotFoundException,
  ServiceNotActiveException,
  ServiceNotFoundException
} from '@aws-sdk/client-ecs'

import {
  ParameterAlreadyExists,
  SSM,
  waitUntilCommandExecuted
} from '@aws-sdk/client-ssm'

import { createWaiter, WaiterState } from '@aws-sdk/util-waiter'

import axios from 'axios'
import EventEmitter from 'events'

const APP_NAME = 'codelab'

export default class extends EventEmitter {
  #iam
  #ec2
  #ecr
  #ecs
  #ssm
  #env
  #roleName
  #policyName
  #profileName
  #secGroupName
  #repositoryName
  #clusterName
  #instanceName
  #taskDefName
  #serviceName
  
  constructor({ env }) {
    super()
    this.#iam = new IAM()
    this.#ec2 = new EC2()
    this.#ecr = new ECR()
    this.#ecs = new ECS()
    this.#ssm = new SSM()
    this.#env = env
    this.#roleName = `${APP_NAME}-${env}-role`
    this.#policyName =  `${APP_NAME}-${env}-policy`
    this.#profileName = `${APP_NAME}-${env}-profile`
    this.#secGroupName = `${APP_NAME}-${env}-secgroup`
    this.#repositoryName = `${APP_NAME}-${env}-repository`
    this.#clusterName = `${APP_NAME}-${env}-cluster`
    this.#instanceName = `${APP_NAME}-${env}-instance`
    this.#taskDefName = `${APP_NAME}-${env}-taskdef`
    this.#serviceName = `${APP_NAME}-${env}-service`
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

  #ecsTags(name) {
    return [{
      key: 'Application',
      value: APP_NAME
    }, {
      key: 'Environment',
      value: this.#env
    }, {
      key: 'Name',
      value: name
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
    const cluster = this.#clusterName
    const service = this.#serviceName
    
    this.emit('begin', { name: 'Delete service' })
    try {
      await this.#ecs.updateService({ cluster, service, desiredCount: 0 })
      await this.#ecs.deleteService({ cluster, service })
    } catch (error) {
      if (!(
        error instanceof ClusterNotFoundException ||
        error instanceof ServiceNotActiveException ||
        error instanceof ServiceNotFoundException
      )) {
        throw error
      }
    }
    this.emit('success')

    const familyPrefix = this.#taskDefName

    // TODO: if the list of task definitions gets too long for one request, pagination will be needed
    this.emit('begin', { name: 'Delete task definition' })
    const { taskDefinitionArns } = await this.#ecs.listTaskDefinitions({ familyPrefix, status: 'ACTIVE' })
    for (const taskDefinition of taskDefinitionArns) {
      await this.#ecs.deregisterTaskDefinition({ taskDefinition })
    }
    const taskDefinitions = taskDefinitionArns.concat(
      (await this.#ecs.listTaskDefinitions({ familyPrefix, status: 'INACTIVE' })).taskDefinitionArns
    )
    if (taskDefinitions.length > 0) {
      // TODO: task definitions can only be deleted up to ten at a time
      await this.#ecs.deleteTaskDefinitions({ taskDefinitions })
    }
    this.emit('success') 
    
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

    this.emit('begin', { name: 'Delete cluster' })
    try {
      await this.#ecs.deleteCluster({ cluster })
    } catch (error) {
      if (!(error instanceof ClusterNotFoundException)) {
        throw error
      }
    }
    this.emit('success')

    this.emit('begin', { name: 'Delete repository' })
    try {
      await this.#ecr.deleteRepository({
        repositoryName: this.#repositoryName,
        force: true
      })
    } catch (error) {
      if (!(error instanceof RepositoryNotFoundException)) {
        throw error
      }
    }
    this.emit('success')

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

  async setUp({ infra, repo, passwordHash }) {
    let useECS
    
    switch (infra) {
      case 'aws-swarm':
        useECS = false
        break
      case 'aws-ecs':
        useECS = true
        break
      default:
        throw new Error(`infrastructure '${infra}' not supported`)
    }

    const serverPort = 8080
    const proxyHttpPort = 80
    const proxyHttpsPort = 443

    const ParameterPath = '/codelab'

    this.emit('begin', { name: 'Create parameters' })
    try {
      await this.#ssm.putParameter({
        Tags: this.#tags(`${APP_NAME}-${this.#env}-param-HASHED_PASSWORD`),
        Type: 'SecureString',
        Name: `${ParameterPath}/HASHED_PASSWORD`,
        Value: passwordHash
      })
    } catch (error) {
      if (!(error instanceof ParameterAlreadyExists)) {
        throw error
      }
      await this.#ssm.putParameter({
        Type: 'SecureString',
        Name: `${ParameterPath}/HASHED_PASSWORD`,
        Value: passwordHash,
        Overwrite: true
      })
    }
    this.emit('success')

    const { Parameters } = await this.#task(
      'Get parameters',
      this.#ssm.describeParameters({
        ParameterFilters: [{
          Key: 'Path',
          Values: [ParameterPath]
        }]
      })
    )

    const RoleName = this.#roleName
    const AssumeRolePolicyDocument = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Action: 'sts:AssumeRole',
        Principal: {
          Service: useECS
            ? ['ec2.amazonaws.com', 'ecs-tasks.amazonaws.com']
            : ['ec2.amazonaws.com']
        }
      }]
    })

    let RoleArn

    this.emit('begin', { name: 'Create role' })
    try {
      if (useECS) {
        RoleArn = (await this.#iam.getRole({ RoleName })).Role.Arn
      }
      await this.#iam.updateAssumeRolePolicy({ RoleName, PolicyDocument: AssumeRolePolicyDocument })
    } catch (error) {
      if (!(error instanceof NoSuchEntityException)) {
        throw error
      }
      RoleArn = (await this.#iam.createRole({
        Tags: this.#tags(RoleName),
        RoleName,
        AssumeRolePolicyDocument
      })).Role.Arn
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

    const repositoryName = this.#repositoryName
    const clusterName = this.#clusterName
    let repositoryUri

    if (useECS) {
      this.emit('begin', { name: 'Create repository' })
      try {
        const { repositories } = await this.#ecr.describeRepositories({ repositoryNames: [repositoryName] })
        repositoryUri = repositories[0].repositoryUri
      } catch (error) {
        if (!(error instanceof RepositoryNotFoundException)) {
          throw error
        }
        const { repository } = await this.#ecr.createRepository({
          tags: this.#tags(repositoryName),
          repositoryName
        })
        repositoryUri = repository.repositoryUri
      }
      this.emit('success')
  
      // TODO: cluster names are limited to /^[a-zA-Z0-9\-_]{1,255}$/
      await this.#task(
        'Create cluster',
        this.#ecs.createCluster({
          tags: this.#ecsTags(clusterName),
          clusterName
        })
      )
    }

    const instanceName = this.#instanceName

    const commands = []

    if (useECS) {
      commands.concat([
        `echo ECS_CLUSTER=${clusterName} > /etc/ecs/ecs.config`,
        `echo ECS_CONTAINER_INSTANCE_PROPAGATE_TAGS_FROM=${instanceName} >> /etc/ecs/ecs.config`
      ])
    }

    commands.concat([
      `mkdir --parents /usr/share/codelab`,
      `curl --location https://rpm.nodesource.com/setup_16.x | sh -`,
      useECS
        ? `yum install --assumeyes gcc-c++ git nodejs unzip`
        : `yum install --assumeyes docker gcc-c++ git nodejs`,
    ])

    if (useECS) {
      commands.concat([
        `curl --output /usr/share/codelab/awscliv2.zip --location https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip`,
        `unzip -u /usr/share/codelab/awscliv2.zip`,
        `./aws/install --update`
      ])
    }

    commands.concat([
      `npm install --global @devcontainers/cli`,
    ])

    if (!useECS) {
      commands.concat([
        `systemctl start docker`,
        `if [ "$(docker info --format '{{.Swarm.ControlAvailable}}')" = "false" ];`
          + `then docker swarm init; fi`,
        `if [ "$(docker network ls --filter name=${APP_NAME}-net --format '{{.}}')" = "" ];`
          + `then docker network create --driver overlay ${APP_NAME}-net; fi`,
        // proxy needs to get cycled if already running since the DNS name may have changed
        `if [ "$(docker service ls --filter name=caddy --format '{{.}}')" != "" ];`
          + `then docker service rm caddy; fi`,
        `DIG_OUT=$(dig +short -x $(dig +short @resolver4.opendns.com myip.opendns.com))`,
        `docker service create --detach --name caddy --network ${APP_NAME}-net`
          + ` --publish ${proxyHttpPort}:${proxyHttpPort} --publish ${proxyHttpsPort}:${proxyHttpsPort}`
          + ` caddy caddy reverse-proxy --from \${DIG_OUT::-1}:${proxyHttpsPort} --to code-server:${serverPort}`
      ])
    }

    commands.concat([
      `echo "/usr/local/bin/aws ssm get-parameter --with-decryption --output text --name /codelab/GIT_PASSWORD --query Parameter.Value" > /usr/share/codelab/git-askpass.sh`,
      // owner: rwx, group: r, others: r
      `chmod 0744 /usr/share/codelab/git-askpass.sh`,
      `if [ ! -d /srv/workspace ];`
        + `then GIT_ASKPASS=/usr/share/codelab/git-askpass.sh git clone https://awkward-ninja@github.com/${repo}.git /srv/workspace; fi`,
      `curl --location --create-dirs --output /usr/share/codelab/install-code-server.sh https://code-server.dev/install.sh`,
      // owner: rwx, group: rx, others: rx
      'chmod 0755 /usr/share/codelab/install-code-server.sh',
      `devcontainer build --image-name code-server --workspace-folder /srv/workspace`
    ])

    if (useECS) {
      commands.concat([
        `docker tag code-server ${repositoryUri}`,
        `/usr/local/bin/aws ecr get-login-password | docker login --password-stdin --username AWS ${repositoryUri}`,
        `docker push ${repositoryUri}`,
      ])
    }

    commands.concat([
      `chown --recursive $(docker run --rm code-server id --user) /srv/workspace`
    ])

    if (!useECS) {
      commands.concat([
        `if [ "$(docker service ls --filter name=code-server --format '{{.}}')" = "" ];`
          + `then ` + [
            // TODO: find a more secure way to retrieve this value
            `echo '${passwordHash}' | docker secret create CODE_SERVER_HASHED_PASSWORD -`,
            `AWS_PARAMS=$(aws resourcegroupstaggingapi get-resources --output text --resource-type-filters ssm:parameter --tag-filters Key=codelab:env --query ResourceTagMappingList[].[ResourceARN])`,
            `if [ "$AWS_PARAMS" != "" ];`
              + `then echo "$AWS_PARAMS" | sed --regexp-extended 's/^[^/]*\\/(_?)(.*)$/\\1\\2 \\2/'`
                + `| xargs --max-args=2 sh -c 'echo $(aws ssm get-parameter --with-decryption --output text --name $0 --query Parameter.Value) | docker secret create $1 -'`
              + `; fi`,
            `docker service create --detach --name code-server --network ${APP_NAME}-net`
              + ` --secret CODE_SERVER_HASHED_PASSWORD`
              + ` $(echo "$AWS_PARAMS" | sed --regexp-extended 's/^[^/]*\\/_?(.*)$/--secret \\1/')`
              + ` --mount type=bind,source=/usr/share/codelab,destination=/mnt/codelab`
              + ` --mount type=bind,source=/srv,destination=/srv`
              + ` code-server sh -c "` + [
                `/mnt/codelab/install-code-server.sh --method=standalone`,
                `HASHED_PASSWORD=\\$(cat /run/secrets/CODE_SERVER_HASHED_PASSWORD) ~/.local/bin/code-server --bind-addr 0.0.0.0:${serverPort} /srv/workspace`
              ].join(` && `) + `"`
          ].join(` && `) + `; fi`
         // TODO: at least update CODE_SERVER_HASHED_PASSWORD when service is already running
      ])
    }

    const script = commands.join(` && `)

    let InstanceId

    this.emit('begin', { name: 'Run instance' })
    const InstanceIds = await this.#eligibleInstanceIds()
    if (InstanceIds.length === 0) {
      InstanceId = (await this.#ec2.runInstances({
        TagSpecifications: this.#tagSpecs('instance', instanceName),
        MinCount: 1,
        MaxCount: 1,
        InstanceType: 't2.small',
        
        ImageId: useECS
          // ECS-Optimized Amazon Linux 2 (2.0.20230406)
          ? 'ami-0be4bf0879ccaadb3'
          // Amazon Linux 2 Kernel 5.10
          : 'ami-06e85d4c3149db26a',
        SecurityGroupIds: [GroupId],
        UserData: btoa(`#! /bin/sh\n${script}`)
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

      await this.#ssmCommandTask('Provision instance', InstanceId, [script])
    }

    const PublicUrl = `https://${PublicDnsName}`

    if (useECS) {
      // TODO: update secrets when service is already running
      // TODO: maybe environment variables aren't secure enough, Docker Swarm stores them at /run/secrets
      const secrets = Parameters.map(({ Name }) => ({
        name: Name.substring(ParameterPath.length + 1),
        valueFrom: Name
      }))

      // TODO: this will just keep creating new revisions on every invocation
      // TODO: if there is a previous active definition, deregister and delete it
      // TODO: prolly should wait for image to be pushed to registry before referencing it
      await this.#task(
        'Create task definition',
        this.#ecs.registerTaskDefinition({
          tags: this.#ecsTags(this.#taskDefName),
          family: this.#taskDefName,
          memory: '1920', // available on instance (shouldn't need this for EC2 launch type though!?)
          executionRoleArn: RoleArn,
          volumes: [{
            name: `${APP_NAME}-mnt`,
            host: { sourcePath: '/usr/share/codelab' }
          }, {
            name: `${APP_NAME}-srv`,
            host: { sourcePath: '/srv' }
          }],
          containerDefinitions: [{
            name: 'caddy',
            image: 'caddy',
            portMappings: [{
              containerPort: proxyHttpPort,
              hostPort: proxyHttpPort
            }, {
              containerPort: proxyHttpsPort,
              hostPort: proxyHttpsPort
            }],
            // TODO: Docker links are deprecated, this should eventually
            // be replaced by awsvpc network mode and/or service discovery
            // https://docs.docker.com/network/links/
            links: ['code-server'],
            command: [
              `caddy`,
              `reverse-proxy`,
              `--from`, `${PublicUrl}:${proxyHttpsPort}`,
              `--to`, `code-server:${serverPort}`
            ]
          }, {
            name: 'code-server',
            image: `${repositoryUri}:latest`,
            secrets,
            mountPoints: [{
              sourceVolume: `${APP_NAME}-mnt`,
              containerPath: '/mnt/codelab'
            }, {
              sourceVolume: `${APP_NAME}-srv`,
              containerPath: '/srv'
            }],
            command: [
              `sh`, `-c`, [
                `/mnt/codelab/install-code-server.sh --method=standalone`,
                `~/.local/bin/code-server --bind-addr 0.0.0.0:${serverPort} /srv/workspace`
              ].join(' && ')
            ]
          }]
        })
      )
  
      const serviceName = this.#serviceName
  
      // TODO: wait for container instance to exist to avoid warning/error event
      this.emit('begin', { name: 'Create service' })
      try {
        await this.#ecs.updateService({
          cluster: clusterName,
          service: serviceName,
          taskDefinition: this.#taskDefName,
          desiredCount: 1
        })
      } catch (error) {
        if (!(error instanceof ServiceNotActiveException || error instanceof ServiceNotFoundException)) {
          throw error
        }
        await this.#ecs.createService({
          tags: this.#ecsTags(serviceName),
          cluster: clusterName,
          serviceName,
          taskDefinition: this.#taskDefName,
          desiredCount: 1
        })
      }
      this.emit('success')
    }

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
