/* -----------------------------------------------------------------------------
| Copyright (c) Jupyter Development Team.
| Distributed under the terms of the Modified BSD License.
|----------------------------------------------------------------------------*/

import { showErrorMessage } from '@jupyterlab/apputils';
import { caretDownIcon, caretRightIcon } from '@jupyterlab/ui-components';
import { Settings } from '@jupyterlab/settingregistry';
import { ITranslator } from '@jupyterlab/translation';
import { reduce } from '@lumino/algorithm';
import { JSONExt, ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { Debouncer } from '@lumino/polling';
import Form, {
  ArrayFieldTemplateProps,
  Field,
  FieldTemplateProps,
  IChangeEvent,
  UiSchema
} from '@rjsf/core';
import { JSONSchema7 } from 'json-schema';
import React from 'react';
import { PluginList } from './pluginlist';

/**
 * Namespace for a React component that prepares the settings for a
 * given plugin to be rendered in the FormEditor.
 */
export namespace SettingsFormEditor {
  /**
   * Props passed to the SettingsFormEditor component
   */
  export interface IProps {
    /**
     * Settings object with schema and user defined values.
     */
    settings: Settings;

    /**
     * Dictionary used for custom field renderers in the form.
     */
    renderers: { [id: string]: Field };

    /**
     * Whether the form is collapsed or not.
     */
    isCollapsed: boolean;

    /**
     * Callback with the collapse state value.
     */
    onCollapseChange: (v: boolean) => void;

    /**
     * Translator object
     */
    translator: ITranslator;

    /**
     * Callback to update the plugin list when a validation error occurs.
     */
    hasError: (error: boolean) => void;

    /**
     * Handler for when selection change is triggered by scrolling
     * in the SettingsPanel.
     */
    onSelect: (id: string) => void;

    /**
     * Sends whether this editor has unsaved changes to the parent class.
     */
    updateDirtyState: (dirty: boolean) => void;
  }

  export interface IState {
    /**
     * The current form values being displayed in the editor.
     */
    formData: any;

    /**
     * Indicates whether the settings have been modified. Used for hiding
     * the "Restore to Default" button when there are no changes.
     */
    isModified: boolean;
  }
}

/**
 * Template to allow for custom buttons to re-order / removal of entries in an array.
 * Necessary to create accessible buttons.
 */
const CustomArrayTemplateFactory = (
  translator: ITranslator
): React.FC<ArrayFieldTemplateProps> => {
  const trans = translator.load('jupyterlab');

  const factory = (props: ArrayFieldTemplateProps) => {
    return (
      <div className={props.className}>
        <props.TitleField
          title={props.title}
          required={props.required}
          id={`${props.idSchema.$id}-title`}
        />
        <props.DescriptionField
          id={`${props.idSchema.$id}-title`}
          description={props.schema.description ?? ''}
        />
        {props.items.map(item => {
          return (
            <div key={item.key} className={item.className}>
              {item.children}
              <div className="jp-ArrayOperations">
                <button
                  onClick={item.onReorderClick(item.index, item.index - 1)}
                  disabled={!item.hasMoveUp}
                >
                  {trans.__('Move Up')}
                </button>
                <button
                  onClick={item.onReorderClick(item.index, item.index + 1)}
                  disabled={!item.hasMoveDown}
                >
                  {trans.__('Move Down')}
                </button>
                <button
                  onClick={item.onDropIndexClick(item.index)}
                  disabled={!item.hasRemove}
                >
                  {trans.__('Remove')}
                </button>
              </div>
            </div>
          );
        })}
        {props.canAdd && (
          <button
            className="array-item-add"
            onClick={() => {
              props.onAddClick();
            }}
          >
            {trans.__('Add')}
          </button>
        )}
      </div>
    );
  };
  factory.displayName = 'CustomArrayTemplate';
  return factory;
};

/**
 * Renders the modified indicator and errors
 */
const CustomTemplate = (props: FieldTemplateProps) => {
  const {
    formData,
    schema,
    label,
    displayLabel,
    id,
    formContext,
    errors,
    rawErrors,
    children
  } = props;
  /**
   * Determine if the field has been modified
   * Schema Id is formatted as 'root_<field name>.<nexted field name>'
   * This logic parses out the field name to find the default value
   * before determining if the field has been modified.
   */
  const schemaIds = id.split('_');
  schemaIds.shift();
  const schemaId = schemaIds.join('.');
  let defaultValue;
  if (schemaIds.length === 1) {
    defaultValue = formContext.settings.default(schemaId);
  } else if (schemaIds.length > 1) {
    const allDefaultsForObject: any = {};
    allDefaultsForObject[schemaIds[0]] = formContext.settings.default(
      schemaIds[0]
    );
    defaultValue = reduce(
      schemaIds,
      (acc, val, i) => {
        return acc?.[val];
      },
      allDefaultsForObject
    );
  }
  const isModified =
    schemaId !== '' &&
    formData !== undefined &&
    defaultValue !== undefined &&
    !schema.properties &&
    schema.type !== 'array' &&
    !JSONExt.deepEqual(formData, defaultValue);

  return (
    <div
      className={`form-group ${
        (displayLabel || schema.type === 'boolean') && 'small-field'
      }`}
    >
      {
        // Only show the modified indicator if there are no errors
        isModified && !rawErrors && <div className="jp-modifiedIndicator" />
      }
      {
        // Shows a red indicator for fields that have validation errors
        rawErrors && <div className="jp-modifiedIndicator jp-errorIndicator" />
      }
      <div>
        {displayLabel && schemaId !== '' && <h3> {label} </h3>}
        <div className={`${schemaId === '' ? 'root' : 'inputFieldWrapper'}`}>
          {children}
        </div>
        <div className="validationErrors">{errors}</div>
      </div>
    </div>
  );
};

/**
 * A React component that prepares the settings for a
 * given plugin to be rendered in the FormEditor.
 */
export class SettingsFormEditor extends React.Component<
  SettingsFormEditor.IProps,
  SettingsFormEditor.IState
> {
  constructor(props: SettingsFormEditor.IProps) {
    super(props);
    const { settings } = props;
    this.state = {
      formData: settings.composite,
      isModified: settings.isModified
    };
    this.handleChange = this.handleChange.bind(this);
    this._debouncer = new Debouncer(this.handleChange);
  }

  /**
   * Handler for edits made in the form editor.
   * @param data - Form data sent from the form editor
   */
  handleChange(): void {
    // Prevent unnecessary save when opening settings that haven't been modified.
    if (
      !this.props.settings.isModified &&
      this.props.settings.isDefault(this.state.formData)
    ) {
      this.props.updateDirtyState(false);
      return;
    }
    this.props.settings
      .save(JSON.stringify(this.state.formData))
      .then(() => {
        this.props.updateDirtyState(false);
        this.setState({ isModified: this.props.settings.isModified });
      })
      .catch((reason: string) => {
        this.props.updateDirtyState(false);
        const trans = this.props.translator.load('jupyterlab');
        showErrorMessage(trans.__('Error saving settings.'), reason);
      });
  }

  /**
   * Handler for the "Restore to defaults" button - clears all
   * modified settings then calls `setFormData` to restore the
   * values.
   */
  reset = async (): Promise<void> => {
    for (const field in this.props.settings.user) {
      await this.props.settings.remove(field);
    }
    this.setState({
      formData: this.props.settings.composite,
      isModified: false
    });
  };

  render(): JSX.Element {
    const trans = this.props.translator.load('jupyterlab');

    /**
     * Construct uiSchema to pass any custom renderers to the form editor.
     */
    const uiSchema: UiSchema = {};
    for (const id in this.props.renderers) {
      if (
        Object.keys(this.props.settings.schema.properties ?? {}).includes(id)
      ) {
        uiSchema[id] = {
          'ui:field': id
        };
      }
    }
    const icon = this.props.isCollapsed ? caretRightIcon : caretDownIcon;

    return (
      <div>
        <div
          className="jp-SettingsHeader"
          onClick={() => {
            this.props.onCollapseChange(!this.props.isCollapsed);
            this.props.onSelect(this.props.settings.id);
          }}
        >
          <div className="jp-SettingsTitle">
            <icon.react tag="span" elementPosition="center" />
            <h2> {this.props.settings.schema.title} </h2>
            <h3> {this.props.settings.schema.description} </h3>
          </div>
          {this.state.isModified && (
            <button className="jp-RestoreButton" onClick={this.reset}>
              {trans.__('Restore to Defaults')}
            </button>
          )}
        </div>
        {!this.props.isCollapsed && (
          <Form
            schema={this.props.settings.schema as JSONSchema7}
            formData={this.state.formData}
            FieldTemplate={CustomTemplate}
            ArrayFieldTemplate={CustomArrayTemplateFactory(
              this.props.translator
            )}
            uiSchema={uiSchema}
            fields={this.props.renderers}
            formContext={{ settings: this.props.settings }}
            liveValidate
            idPrefix={`jp-SettingsEditor-${this.props.settings.id}`}
            onChange={(e: IChangeEvent<ReadonlyPartialJSONObject>) => {
              this.props.hasError(e.errors.length !== 0);
              this.setState({ formData: e.formData });
              if (e.errors.length === 0) {
                this.props.updateDirtyState(true);
                void this._debouncer.invoke();
              }
              this.props.onSelect(this.props.settings.id);
            }}
          />
        )}
      </div>
    );
  }

  protected onSelect = (list: PluginList, id: string): void => {
    if (id === this.props.settings.id) {
      this.props.onCollapseChange(false);
    }
  };

  private _debouncer: Debouncer<void, any>;
}
