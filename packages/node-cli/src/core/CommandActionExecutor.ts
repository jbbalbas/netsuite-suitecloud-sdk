/*
 ** Copyright (c) 2020 Oracle and/or its affiliates.  All rights reserved.
 ** Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl.
 */
'use strict';

import ActionResultUtils from '../utils/ActionResultUtils';
import { ActionResult } from '../commands/actionresult/ActionResult';

import assert from 'assert';
import inquirer from 'inquirer';
import NodeTranslationService from '../services/NodeTranslationService';
import { ERRORS } from '../services/TranslationKeys';
import { throwValidationException } from '../utils/ExceptionUtils';
import OperationResultStatus from '../commands/OperationResultStatus';
import * as SDKOperationResultUtils from '../utils/SDKOperationResultUtils';
import CLIConfigurationService from './extensibility/CLIConfigurationService';
import CommandsMetadataService from './CommandsMetadataService';
import AuthenticationService from './authentication/AuthenticationService';
import CommandInstanceFactory from './CommandInstanceFactory';
import CommandOptionsValidator from './CommandOptionsValidator';
import CommandOutputHandler from './CommandOutputHandler';
import { ActionContext } from '../../types/CommandContext';
import { InteractiveCommandInfo, NonInteractiveCommandInfo, SKDCommandOption, NodeCommandOption } from '../../types/Metadata';
import Command from '../commands/Command';
import CommandUserExtension from './extensibility/CommandUserExtension';
import { OperationResult } from '../../types/OperationResult';
import OutputFormatter from '../commands/outputFormatters/OutputFormatter';


type Depenendencies = {
	executionPath: string;
	commandOptionsValidator: CommandOptionsValidator;
	cliConfigurationService: CLIConfigurationService;
	commandInstanceFactory: CommandInstanceFactory;
	commandsMetadataService: CommandsMetadataService;
	commandOutputHandler: CommandOutputHandler;
	authenticationService: AuthenticationService;
}

export default class CommandActionExecutor {

	private executionPath: string;
	private commandOptionsValidator: CommandOptionsValidator;
	private cliConfigurationService: CLIConfigurationService
	private commandInstanceFactory: CommandInstanceFactory;
	private commandsMetadataService: CommandsMetadataService;
	private commandOutputHandler: CommandOutputHandler;
	private authenticationService: AuthenticationService;

	constructor(dependencies: Depenendencies) {
		assert(dependencies);
		assert(dependencies.executionPath);
		assert(dependencies.commandOptionsValidator);
		assert(dependencies.cliConfigurationService);
		assert(dependencies.commandInstanceFactory);
		assert(dependencies.commandsMetadataService);
		assert(dependencies.authenticationService);
		assert(dependencies.consoleLogger);

		this.executionPath = dependencies.executionPath;
		this.commandOptionsValidator = dependencies.commandOptionsValidator;
		this.cliConfigurationService = dependencies.cliConfigurationService;
		this.commandInstanceFactory = dependencies.commandInstanceFactory;
		this.commandsMetadataService = dependencies.commandsMetadataService;
		this.authenticationService = dependencies.authenticationService;
		this.consoleLogger = dependencies.consoleLogger;
	}

	public async executeAction(context: ActionContext) {
		assert(context);
		assert(context.arguments);
		assert(context.commandName);
		assert(typeof context.runInInteractiveMode === 'boolean');

		let commandUserExtension;
		try {
			const commandMetadata = this.commandsMetadataService.getCommandMetadataByName(context.commandName);
			const commandName = context.commandName;

			this.cliConfigurationService.initialize(this.executionPath);
			const projectFolder = this.cliConfigurationService.getProjectFolder(commandName);
			commandUserExtension = this.cliConfigurationService.getCommandUserExtension(commandName);

			const runInInteractiveMode = context.runInInteractiveMode;
			const args = context.arguments;

			const projectConfiguration = commandMetadata.isSetupRequired ? this.authenticationService.getProjectDefaultAuthId() : undefined;
			this.checkCanExecute({ runInInteractiveMode, commandMetadata, projectConfiguration });

			const command = await this.commandInstanceFactory.create({
				runInInteractiveMode: runInInteractiveMode,
				commandMetadata: commandMetadata,
				projectFolder: projectFolder,
				executionPath: this.executionPath,
				consoleLogger: this.consoleLogger,
			});

			const commandArguments = this.extractOptionValuesFromArguments(command.commandMetadata.options, args);

			const actionResult = await this.executeCommandAction({
				command: command,
				arguments: commandArguments,
				runInInteractiveMode: context.runInInteractiveMode,
				isSetupRequired: commandMetadata.isSetupRequired,
				commandUserExtension: commandUserExtension,
				projectConfiguration: projectConfiguration,
			});

			if (!(actionResult instanceof ActionResult)) {
				throw 'INTERNAL ERROR: Command must return an ActionResult object.';
			}

			if (actionResult.status === ActionResult.STATUS.ERROR) {
				const error = ActionResultUtils.getErrorMessagesString(actionResult);
				throw error;
			}

			command.outputFormatter.formatActionResult(actionResult);

			if (commandUserExtension.onCompleted) {
				commandUserExtension.onCompleted(actionResult);
			}

			return actionResult;
		} catch (error) {
			let errorMessage = new OutputFormatter(this.consoleLogger).formatError(error);
			if (commandUserExtension && commandUserExtension.onError) {
				commandUserExtension.onError(error);
			}
			return ActionResult.Builder.withErrors(errorMessage);
		}
	}

	private checkCanExecute(context: { runInInteractiveMode: boolean; commandMetadata: InteractiveCommandInfo | NonInteractiveCommandInfo; projectConfiguration?: string }) {
		if (context.commandMetadata.isSetupRequired && !context.projectConfiguration) {
			throw NodeTranslationService.getMessage(ERRORS.SETUP_REQUIRED);
		}
		if (context.runInInteractiveMode && !context.commandMetadata.supportsInteractiveMode) {
			throw NodeTranslationService.getMessage(ERRORS.COMMAND_DOES_NOT_SUPPORT_INTERACTIVE_MODE, context.commandMetadata.name);
		}
	}

	private extractOptionValuesFromArguments(options: {
		[x: string]: (SKDCommandOption | NodeCommandOption)
	}, args: { [x: string]: string }) {
		const optionValues: {[x: string]: string} = {};
		for (const optionId in options) {
			if (options.hasOwnProperty(optionId) && args.hasOwnProperty(optionId)) {
				optionValues[optionId] = args[optionId];
			}
		}

		return optionValues;
	}

	private async executeCommandAction(options: {
		command: Command;
		arguments: {[x:string]:string};
		runInInteractiveMode: boolean;
		isSetupRequired: boolean;
		commandUserExtension: CommandUserExtension<OperationResult>;
		projectConfiguration?: {[x:string]:string};
	}) {
		const command = options.command;
		const projectConfiguration = options.projectConfiguration;
		const isSetupRequired = options.isSetupRequired;
		const runInInteractiveMode = options.runInInteractiveMode;
		const commandUserExtension = options.commandUserExtension;
		let commandArguments = options.arguments;

		try {
			const beforeExecutingOutput = await commandUserExtension.beforeExecuting({
				command: this,
				arguments: isSetupRequired ? this.applyDefaultContextParams(commandArguments, projectConfiguration) : commandArguments
			});
			const overriddenCommandArguments = beforeExecutingOutput.arguments;

			const argumentsFromQuestions =
				runInInteractiveMode || command.commandMetadata.forceInteractiveMode
					? await command.getCommandQuestions(inquirer.prompt, commandArguments)
					: {};

			const commandArgumentsWithQuestionArguments = {
				...overriddenCommandArguments,
				...argumentsFromQuestions,
			};
			let commandArgumentsAfterPreActionFunc = command.preActionFunc
				? command.preActionFunc(commandArgumentsWithQuestionArguments)
				: commandArgumentsWithQuestionArguments;

			this.checkCommandValidationErrors(commandArgumentsAfterPreActionFunc, command.commandMetadata, runInInteractiveMode);

			return await command.action(commandArgumentsAfterPreActionFunc);
		} catch (error) {
			throw error;
		}
	}

	private checkCommandValidationErrors(
		commandArgumentsAfterPreActionFunc: any,
		commandMetadata: InteractiveCommandInfo | NonInteractiveCommandInfo,
		runInInteractiveMode: boolean
	) {
		const validationErrors = this.commandOptionsValidator.validate({
			commandOptions: commandMetadata.options,
			arguments: commandArgumentsAfterPreActionFunc,
		});

		if (validationErrors.length > 0) {
			throwValidationException(validationErrors, runInInteractiveMode, commandMetadata);
		}
	}

	private applyDefaultContextParams(args: {[x: string]: string;}, projectConfiguration?: {[x:string]:string}) {
		if (projectConfiguration && projectConfiguration.defaultAuthId) {
			args.authId = projectConfiguration.defaultAuthId;
		}
		return args;
	}
};